import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SEOUL_REGULAR_SESSION_MS } from "../../../lib/market-hours";
import { setNowMs } from "../../../src/clock";
import { FakeBroker, makeTestPaperState } from "../../../src/test-support/index";
import { observeAiProposals } from "./observe";

const fixtureNowMs = Date.parse("2026-09-21T09:00:00Z");

function proposal(proposalId: string, action: string) {
  return {
    proposalId,
    action,
    schemaVersion: "ai.trade-proposal.v1",
    dataMode: "FIXTURE",
    generatedAt: "2026-09-21T09:00:00Z",
    analysisAsOf: "2026-09-21T09:00:00Z",
    validUntil: "2026-09-21T10:00:00Z",
    modelVersion: "m1",
    featureVersion: "f1",
    policyVersion: "p1",
    market: "KRX",
    ticker: "005930",
    isOrder: false,
    confidence: 0.4,
    thesis: { headline: "Fixture", summary: "Wait for evidence" },
    reasonCodes: ["FIXTURE_REASON"],
  };
}

async function localAgent(t: TestContext, handle: RequestListener) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "ats-ai-observe-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const server = createServer(handle);
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, outputDir, server };
}

test("HTTP pull records valid observations exactly once across concurrent runs", async (t) => {
  const records = new Map([
    ["buy", proposal("buy", "BUY")],
    ["wait", proposal("wait", "NO_TRADE")],
    ["hold", proposal("hold", "HOLD")],
    ["forged", { ...proposal("forged", "BUY"), isOrder: true }],
    ["old-live", { ...proposal("old-live", "BUY"), dataMode: "LIVE_OBSERVATION", validUntil: "2026-09-21T09:00:00Z" }],
  ]);
  const { baseUrl, outputDir } = await localAgent(t, (req, res) => {
    if (req.url === "/decisions") {
      res.end(JSON.stringify({ items: [...records.keys()].map((decisionId) => ({ decisionId })) }));
      return;
    }
    const id = req.url?.split("/")[2] ?? "";
    res.end(JSON.stringify(records.get(id)));
  });

  const cfg = { baseUrl, fixtureNowMs };
  const results = await Promise.all([observeAiProposals(cfg, outputDir), observeAiProposals(cfg, outputDir)]);
  for (const result of results) {
    assert.equal(result.fetched, 5);
    assert.deepEqual(result.accepted.map((row) => row.action), ["BUY", "NO_TRADE", "HOLD"]);
    assert.deepEqual(result.rejected.map((row) => row.code), ["IS_ORDER_FORBIDDEN", "EXPIRED"]);
    assert.equal(result.orderEligibleCount, 0);
    assert.equal(result.autoOrderEnabled, false);
  }
  assert.equal(results[0].stored + results[1].stored, 3);
  assert.equal(results[0].duplicates + results[1].duplicates, 3);
  const files = await readdir(outputDir);
  assert.equal(files.length, 3);
  const saved = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(outputDir, file), "utf8"))));
  assert.ok(saved.every((row) => row.orderEligible === false && row.autoOrderEnabled === false));
  const noTrade = saved.find((row) => row.proposal.action === "NO_TRADE");
  assert.equal(noTrade?.proposal.thesis.summary, "Wait for evidence");
  assert.deepEqual(noTrade?.proposal.reasonCodes, ["FIXTURE_REASON"]);

  const recent = await observeAiProposals({ ...cfg, maxPages: 2 }, outputDir);
  assert.equal(recent.fetched, 2);
  assert.deepEqual(recent.rejected.map((row) => row.decisionId), ["forged", "old-live"]);
});

test("failed envelope reads keep upstream errors and leave the store empty", async (t) => {
  const { baseUrl, outputDir } = await localAgent(t, (req, res) => {
    if (req.url === "/decisions") {
      res.end(JSON.stringify({ items: [{ decisionId: "unavailable" }, { decisionId: "bad-json" }] }));
    } else if (req.url?.includes("unavailable")) {
      res.writeHead(503).end();
    } else {
      res.end("invalid JSON");
    }
  });
  const result = await observeAiProposals({ baseUrl }, outputDir);
  assert.deepEqual(result.rejected.map((row) => row.code), ["RETRYABLE_UPSTREAM", "INVALID_JSON"]);
  assert.equal(result.stored, 0);
  assert.deepEqual(await readdir(outputDir), []);
});

test("an AI HTTP timeout leaves the existing FakeBroker order gates independent", async (t) => {
  const { baseUrl, outputDir, server } = await localAgent(t, () => {});
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  t.after(() => setNowMs(null));
  const requested = once(server, "request");
  let aiFinished = false;
  const pending = observeAiProposals({ baseUrl, timeoutMs: 1_000 }, outputDir).then((result) => {
    aiFinished = true;
    return result;
  });
  await requested;

  const box = { current: makeTestPaperState() };
  box.current.settings.autoTrading = true;
  box.current.settings.disclaimerAccepted = true;
  box.current.settings.ignoreMarketHours = true;
  const broker = new FakeBroker(box, "cash");
  const initialCount = box.current.orders.length;
  assert.equal((await broker.buyMarket("005930", 150_000)).ok, true);
  assert.equal(box.current.orders.length, initialCount + 1);
  box.current.settings.disclaimerAccepted = false;
  assert.equal((await broker.buyMarket("005930", 150_000)).ok, false);
  assert.equal(box.current.orders.length, initialCount + 1);
  assert.equal(aiFinished, false);

  const timedOut = await pending;
  assert.equal(timedOut.rejected[0]?.code, "TIMEOUT");
  assert.equal(timedOut.stored, 0);
});
