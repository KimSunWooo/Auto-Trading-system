/**
 * Overseas VTS-A — real KIS PAPER/VTS read-only.
 * Default SKIP. Independent of RUN_KIS_VTS_TESTS / RUN_KIS_VTS_ORDER_TESTS.
 * Never places an overseas or domestic order.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { KisClient } from "@/src/brokers/kis-client";
import { loadKisConfig } from "@/src/brokers/kis-config";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { findOpenOrderByOdno } from "@/src/markets/overseas/mapping";
import {
  vtsOverseasOrderTestsEnabled,
  vtsOverseasReadTestsEnabled,
} from "@/src/markets/overseas/env";
import {
  appendVtsEvent,
  assertVtsSafeEnv,
  beginVtsTestRun,
  envSnapshotWithoutSecrets,
  finishVtsTestRun,
  realTradingFlags,
  type VtsRunOutcome,
  type VtsTestRun,
  type VtsTrace,
} from "@/src/runtime/vts-harness";

type Verification = VtsTrace["verification"];

const verification: Record<string, Verification> = {};
let run: VtsTestRun | undefined;
let client: KisClient | undefined;
let outcome: VtsRunOutcome = "PASS";
let orderPosts = 0;
let realHostHits = 0;

function mark(id: string, value: Verification) {
  verification[id] = value;
}

function failRun() {
  outcome = "FAIL";
}

function ensureRun(testCaseId: string): VtsTestRun {
  run ??= beginVtsTestRun(testCaseId, { market: "overseas" });
  return run;
}

function liveClient(): KisClient | null {
  assertVtsSafeEnv();
  if (!vtsOverseasReadTestsEnabled()) return null;
  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") {
    throw new Error("VTS TEST ABORTED: REAL trading configuration detected.");
  }
  if (!cfg.configured) return null;
  client ??= KisClient.fromEnv();
  return client;
}

function skipRead(t: TestContext, id: string): boolean {
  assertVtsSafeEnv();
  if (!vtsOverseasReadTestsEnabled()) {
    mark(id, "NOT VERIFIED");
    t.skip("NOT VERIFIED: set RUN_KIS_VTS_OVERSEAS_TESTS=true (never REAL, never overseas orders)");
    return true;
  }
  if (!liveClient()) {
    mark(id, "NOT VERIFIED");
    t.skip("NOT VERIFIED: KIS VTS demo credentials are not configured");
    return true;
  }
  return false;
}

before(() => {
  assertVtsSafeEnv();
  assert.equal(vtsOverseasOrderTestsEnabled(), false);
});

after(() => {
  if (run) {
    writeFileSync(
      path.join(run.dir, "verification.json"),
      `${JSON.stringify({ market: "overseas", verification, env: envSnapshotWithoutSecrets(), orderPosts, realHostHits }, null, 2)}\n`,
      "utf8",
    );
    finishVtsTestRun(run, outcome, {
      layer: "OVERSEAS VTS-A",
      market: "overseas",
      verification,
      paperOverseasOrders: orderPosts,
      realRequests: realHostHits,
    });
  }
});

test("OVTS-001 overseas order opt-in is off and REAL flags are absent", () => {
  assertVtsSafeEnv();
  assert.equal(realTradingFlags().length, 0);
  assert.equal(vtsOverseasOrderTestsEnabled(), false);
  mark("OVTS-001", "UNIT");
});

test("OVTS-002 Authentication / Overseas Quote", async (t) => {
  if (skipRead(t, "OVTS-002")) return;
  const live = liveClient()!;
  const active = ensureRun("OVTS-002");
  const instrument = makeUsInstrument("NASDAQ", "AAPL");
  try {
    const quote = await live.inquireOverseasPrice(instrument);
    assert.ok(quote.price > 0);
    assert.equal(quote.source, "kis");
    assert.equal(quote.identity, "NASDAQ:AAPL");
    appendVtsEvent(active.dir, { testCaseId: "OVTS-002", kind: "overseas_quote", identity: quote.identity, price: quote.price, currency: quote.currency });
    mark("OVTS-002", "REAL VTS VERIFIED");
  } catch (err) {
    failRun();
    mark("OVTS-002", "NOT VERIFIED");
    throw err;
  }
});

test("OVTS-003 Foreign cash / buying power / positions / open / executions / recon", async (t) => {
  if (skipRead(t, "OVTS-003")) return;
  const live = liveClient()!;
  const active = ensureRun("OVTS-003");
  try {
    const present = await live.inquireOverseasPresentBalance();
    const usd = present.cash.find((row) => row.currency === "USD");
    appendVtsEvent(active.dir, { testCaseId: "OVTS-003", kind: "foreign_cash", usd: usd?.cash ?? null, fx: present.fx?.rate ?? null });
    const { positions } = await live.inquireOverseasBalance("NASDAQ");
    const open = await live.inquireOverseasOpenOrders("NASDAQ");
    const execs = await live.inquireOverseasExecutions();
    for (const row of open) {
      assert.equal(findOpenOrderByOdno(open, row.orderNo)?.orderNo, row.orderNo);
    }
    const identities = new Set(positions.map((row) => row.identity));
    appendVtsEvent(active.dir, {
      testCaseId: "OVTS-003",
      kind: "overseas_recon",
      positions: positions.length,
      openOrders: open.length,
      executions: execs.length,
      identities: [...identities],
    });
    mark("OVTS-003", "REAL VTS VERIFIED");
  } catch (err) {
    failRun();
    mark("OVTS-003", "NOT VERIFIED");
    throw err;
  }
});
