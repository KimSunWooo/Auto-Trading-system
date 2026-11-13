import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readAiObservationReport, summarizeAiObservations } from "./observation-report";
import { validateAiTradeProposalV1, type AiTradeProposalV1 } from "./trade-proposal-v1";

const nowMs = Date.parse("2026-11-11T06:00:00Z");
const raw = {
  proposalId: "decision-1", schemaVersion: "ai.trade-proposal.v1", dataMode: "LIVE_OBSERVATION",
  generatedAt: "2026-11-11T05:00:00Z", analysisAsOf: "2026-11-11T05:00:00Z", validUntil: "2026-11-11T07:00:00Z",
  modelVersion: "m1", featureVersion: "f1", policyVersion: "p1", market: "KRX", ticker: "005930",
  action: "BUY", isOrder: false, horizon: "SHORT_TERM", expectedReturn: "0.06",
};

test("AI report reads legacy observations and retains Agent's return estimate", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ats-ai-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = (proposal: unknown) => JSON.stringify({
    proposal, observedAt: raw.generatedAt, orderEligible: false, autoOrderEnabled: false,
  });
  await Promise.all([
    writeFile(path.join(directory, `${"a".repeat(64)}.json`), saved(raw)),
    writeFile(path.join(directory, `${"b".repeat(64)}.json`), saved({
      ...raw, proposalId: "legacy", ticker: "000660", expectedReturn: undefined,
    })),
    writeFile(path.join(directory, `${"c".repeat(64)}.json`), "invalid json"),
  ]);
  const report = await readAiObservationReport(directory);
  assert.equal(report.invalidCount, 1);
  assert.equal(report.latest[0].proposal.expectedReturn, 0.06);
  assert.equal(report.latest[1].proposal.expectedReturn, undefined);
});

test("only the latest unexpired live BUY per symbol appears as a recommendation", () => {
  const checked = validateAiTradeProposalV1(raw, { nowMs });
  assert.ok(checked.ok);
  const buy = checked.proposal;
  const row = (proposal: AiTradeProposalV1) => ({ proposal, observedAt: raw.generatedAt });
  const rows = [
    row(buy),
    row({ ...buy, proposalId: "newer-hold", action: "HOLD", analysisAsOf: "2026-11-11T05:30:00Z", generatedAt: "2026-11-11T05:30:00Z" }),
    row({ ...buy, proposalId: "fixture", ticker: "000660", dataMode: "FIXTURE" }),
    row({ ...buy, proposalId: "expired", ticker: "035420", validUntil: raw.generatedAt }),
    row({ ...buy, proposalId: "current", ticker: "069500" }),
  ];
  const result = summarizeAiObservations(rows, nowMs);
  assert.deepEqual(result.recommendations.map(({ proposal }) => proposal.proposalId), ["current"]);
  assert.equal(result.latest.length, 4);
});
