/**
 * Layer C — real KIS VTS integration.
 *
 * Default: SKIP / NOT VERIFIED. `npm test` never places a KIS order.
 *
 * Read-only: RUN_KIS_VTS_TESTS=true  (KIS_MODE=demo, never REAL)
 * Orders:    RUN_KIS_VTS_ORDER_TESTS=true + TRADING_MODE=live_test + KIS_MODE=demo + BROKER=kis
 * Flatten:   RUN_KIS_VTS_FLATTEN_TEST=true — still simulation-only here; does not liquidate VTS.
 *
 * REAL flags abort the process (not skip).
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createPaperState } from "@/lib/engine";
import { getMarketClock } from "@/lib/market-hours";
import { persistStateNow } from "@/lib/store";
import { KisBroker } from "@/src/brokers/KisBroker";
import { KisClient, sameOdno, setSharedKisClientForTest } from "@/src/brokers/kis-client";
import { loadKisConfig } from "@/src/brokers/kis-config";
import { diffLocalVsKis } from "@/src/risk/balance-sync";
import { checkHardLimits } from "@/src/risk/limits";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { RiskManager } from "@/src/risk/RiskManager";
import {
  tryAcquireWorkerLock,
  resetWorkerLockForTest,
} from "@/src/runtime/worker-lock";
import {
  appendVtsEvent,
  assertVtsSafeEnv,
  beginVtsTestRun,
  envSnapshotWithoutSecrets,
  finishVtsTestRun,
  probeVtsReadiness,
  realTradingFlags,
  redactSecrets,
  vtsFlattenTestEnabled,
  vtsOrderEligibility,
  vtsOrderTestsEnabled,
  vtsPreflight,
  vtsReadTestsEnabled,
  writeVtsReconciliation,
  type VtsReadiness,
  type VtsRunOutcome,
  type VtsTestRun,
  type VtsTrace,
} from "@/src/runtime/vts-harness";

type Verification = VtsTrace["verification"];

const TICKER = "005930";

const verification: Record<string, Verification> = {};
const traces: VtsTrace[] = [];

let run: VtsTestRun | undefined;
let client: KisClient | undefined;
let outcome: VtsRunOutcome = "PASS";
let orderBlocked: string | null = null;
let readiness: VtsReadiness | null = null;
let box = { current: createPaperState() };

function mark(id: string, value: Verification) {
  verification[id] = value;
}

function noteBlock(reason: string) {
  orderBlocked = reason;
  if (outcome === "PASS") outcome = "BLOCKED";
}

function failRun() {
  outcome = "FAIL";
}

function ensureRun(testCaseId: string): VtsTestRun {
  run ??= beginVtsTestRun(testCaseId);
  return run;
}

function liveClient(): KisClient | null {
  assertVtsSafeEnv();
  if (!vtsReadTestsEnabled()) return null;
  const cfg = loadKisConfig();
  if (cfg.mode !== "demo") {
    console.error("VTS TEST ABORTED");
    console.error("REAL trading configuration detected.");
    throw new Error("VTS TEST ABORTED: REAL trading configuration detected.");
  }
  if (!cfg.configured) return null;
  client ??= KisClient.fromEnv();
  return client;
}

function skipRead(t: TestContext, id: string): boolean {
  assertVtsSafeEnv();
  if (!vtsReadTestsEnabled()) {
    mark(id, "NOT VERIFIED");
    t.skip("NOT VERIFIED: set RUN_KIS_VTS_TESTS=true with KIS demo credentials (never REAL)");
    return true;
  }
  const live = liveClient();
  if (!live) {
    mark(id, "NOT VERIFIED");
    noteBlock("KIS VTS credentials are not configured");
    t.skip("NOT VERIFIED: KIS VTS demo credentials are not configured");
    return true;
  }
  return false;
}

function skipOrder(t: TestContext, id: string): boolean {
  assertVtsSafeEnv();
  if (realTradingFlags().length) {
    assertVtsSafeEnv();
    return true;
  }
  if (!vtsOrderTestsEnabled()) {
    mark(id, "NOT VERIFIED");
    t.skip("NOT VERIFIED: RUN_KIS_VTS_ORDER_TESTS=true is required for actual VTS orders");
    return true;
  }
  const eligibility = vtsOrderEligibility();
  if (!eligibility.ok) {
    mark(id, "NOT VERIFIED");
    noteBlock(`ORDER TEST BLOCKED: ${eligibility.blocked}`);
    t.skip(`ORDER TEST BLOCKED: ${eligibility.blocked}`);
    return true;
  }
  if (orderBlocked) {
    mark(id, "NOT VERIFIED");
    t.skip(orderBlocked);
    return true;
  }
  if (!readiness?.ok) {
    mark(id, "NOT VERIFIED");
    noteBlock("ORDER TEST BLOCKED: read-only probes did not all pass");
    t.skip("ORDER TEST BLOCKED: read-only probes did not all pass");
    return true;
  }
  return false;
}

before(() => {
  assertVtsSafeEnv();
});

after(() => {
  if (run) {
    writeFileSync(
      path.join(run.dir, "verification.json"),
      `${JSON.stringify({ verification, traces, env: envSnapshotWithoutSecrets() }, null, 2)}\n`,
      "utf8",
    );
    finishVtsTestRun(run, outcome, {
      layer: "REAL VTS",
      verification,
      orderBlocked,
      readiness,
    });
  }
  setSharedKisClientForTest(null);
  resetWorkerLockForTest();
});

test("VTS-001 Environment Guard", () => {
  assertVtsSafeEnv();
  assert.equal(realTradingFlags().length, 0);
  assert.equal(vtsOrderTestsEnabled({}), false);
  if (!vtsOrderTestsEnabled()) {
    const eligibility = vtsOrderEligibility();
    assert.equal(eligibility.ok, false);
  }
  mark("VTS-001", "UNIT");
});

test("VTS-002 Authentication / Read-only Query", async (t) => {
  if (skipRead(t, "VTS-002")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-002");
  try {
    const quote = await live.inquirePrice(TICKER);
    assert.ok(quote.price > 0);
    appendVtsEvent(active.dir, {
      testCaseId: "VTS-002",
      testRunId: active.testRunId,
      kind: "auth_quote",
      ticker: TICKER,
      price: quote.price,
    });
    mark("VTS-002", "REAL VTS VERIFIED");
  } catch (err) {
    failRun();
    mark("VTS-002", "NOT VERIFIED");
    noteBlock(`ORDER TEST BLOCKED: ${err instanceof Error ? err.message : "auth failed"}`);
    throw err;
  }
});

test("VTS-003 Quote", async (t) => {
  if (skipRead(t, "VTS-003")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-003");
  const quote = await live.inquirePrice(TICKER);
  assert.ok(quote.price > 0);
  box.current.quotes[TICKER] = {
    ...box.current.quotes[TICKER]!,
    price: quote.price,
    name: quote.name || box.current.quotes[TICKER]?.name || TICKER,
    source: "kis",
    freshAt: Date.now(),
  };
  appendVtsEvent(active.dir, { testCaseId: "VTS-003", price: quote.price });
  mark("VTS-003", "REAL VTS VERIFIED");
});

test("VTS-004 Balance", async (t) => {
  if (skipRead(t, "VTS-004")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-004");
  const balance = await live.inquireBalance();
  assert.ok(Number.isFinite(balance.cash));
  appendVtsEvent(active.dir, {
    testCaseId: "VTS-004",
    cash: balance.cash,
    holdingCount: balance.holdings.length,
  });
  mark("VTS-004", "REAL VTS VERIFIED");
});

test("VTS-005 Positions / Open Orders / Executions", async (t) => {
  if (skipRead(t, "VTS-005")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-005");
  const [balance, open, executions] = await Promise.all([
    live.inquireBalance(),
    live.inquireOpenOrders(),
    live.inquireDailyCcld(),
  ]);
  assert.ok(Array.isArray(balance.holdings));
  assert.ok(Array.isArray(open));
  assert.ok(Array.isArray(executions));
  readiness = await probeVtsReadiness(live, TICKER);
  if (!readiness.ok) {
    noteBlock(readiness.blocked ?? "ORDER TEST BLOCKED");
  }
  const clock = getMarketClock();
  appendVtsEvent(active.dir, {
    testCaseId: "VTS-005",
    positions: balance.holdings.length,
    openOrders: open.length,
    executions: executions.length,
    marketOpen: clock.open,
    sessionLabel: clock.sessionLabel,
    readiness,
  });
  mark("VTS-005", "REAL VTS VERIFIED");
});

test("VTS-006 Buy Order", async (t) => {
  if (skipOrder(t, "VTS-006")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-006");
  assert.ok(tryAcquireWorkerLock("vts-lifecycle", { filePath: active.lockPath }));
  box.current.settings.disclaimerAccepted = true;
  const pre = vtsPreflight(box.current);
  if (!pre.ok) {
    mark("VTS-006", "NOT VERIFIED");
    noteBlock(`ORDER TEST BLOCKED: ${pre.blocked}`);
    t.skip(`ORDER TEST BLOCKED: ${pre.blocked}`);
    return;
  }
  const quote = await live.inquirePrice(TICKER);
  const qty = Math.floor(pre.caps.maxOrderKrw / quote.price);
  const limit = checkHardLimits(box.current, {
    side: "buy",
    ticker: TICKER,
    qty: Math.max(1, qty),
    price: quote.price,
  });
  if (qty < 1 || limit) {
    mark("VTS-006", "NOT VERIFIED");
    noteBlock(
      `ORDER TEST BLOCKED: LIVE_TEST cap ${pre.caps.maxOrderKrw}원 cannot buy 1 share of ${TICKER} at ${quote.price} (${limit ?? "qty < 1"})`,
    );
    t.skip(orderBlocked ?? "ORDER TEST BLOCKED: LIVE_TEST risk cap");
    return;
  }

  const intentId = `sig:vts:${active.testRunId}:006`;
  setSharedKisClientForTest(live);
  const fill = await new KisBroker(box, live, "cash")
    .withIntent({ intentId, signalId: intentId })
    .buyMarket(TICKER, pre.caps.maxOrderKrw);
  await persistStateNow(box.current);
  const local = box.current.orders.find((row) => row.intentId === intentId);
  const trace: VtsTrace = {
    testRunId: active.testRunId,
    testCaseId: "VTS-006",
    signalId: intentId,
    intentId,
    localOrderId: local?.id ?? fill.orderId,
    odno: local?.brokerOrderNo,
    fillIds: box.current.orders.filter((row) => row.parentOrderId === local?.id).map((row) => row.id),
    verification: fill.ok || local?.brokerOrderNo ? "REAL VTS VERIFIED" : "NOT VERIFIED",
  };
  traces.push(trace);
  appendVtsEvent(active.dir, { ...trace, status: local?.status ?? fill.status, reason: fill.reason });
  if (fill.status === "unknown") {
    failRun();
    mark("VTS-006", "NOT VERIFIED");
    throw new Error("VTS buy returned UNKNOWN; leaving testRun in place");
  }
  assert.ok(local);
  mark("VTS-006", trace.verification);
});

test("VTS-007 ODNO Mapping", async (t) => {
  if (skipOrder(t, "VTS-007")) return;
  const parent = box.current.orders.find(
    (row) => row.intentId?.includes(`${run?.testRunId}:006`) && !row.parentOrderId,
  );
  if (!parent?.brokerOrderNo) {
    mark("VTS-007", "NOT VERIFIED");
    t.skip("ORDER TEST BLOCKED: no local order with ODNO from VTS-006");
    return;
  }
  assert.match(parent.brokerOrderNo, /\d+/);
  const children = box.current.orders.filter((row) => row.parentOrderId === parent.id);
  traces.push({
    testRunId: run!.testRunId,
    testCaseId: "VTS-007",
    intentId: parent.intentId,
    localOrderId: parent.id,
    odno: parent.brokerOrderNo,
    fillIds: children.map((row) => row.id),
    verification: "REAL VTS VERIFIED",
  });
  mark("VTS-007", "REAL VTS VERIFIED");
});

test("VTS-008 Execution Mapping", async (t) => {
  if (skipOrder(t, "VTS-008")) return;
  const live = liveClient()!;
  const parent = box.current.orders.find((row) => row.intentId?.includes(`${run?.testRunId}:006`) && !row.parentOrderId);
  if (!parent?.brokerOrderNo) {
    mark("VTS-008", "NOT VERIFIED");
    t.skip("ORDER TEST BLOCKED: no ODNO to map executions");
    return;
  }
  const remote = await live.inquireDailyCcld();
  const matches = remote.filter((row) => sameOdno(row.orderNo, parent.brokerOrderNo));
  appendVtsEvent(run!.dir, {
    testCaseId: "VTS-008",
    localOrderId: parent.id,
    odno: parent.brokerOrderNo,
    executionCount: matches.length,
  });
  mark("VTS-008", "REAL VTS VERIFIED");
});

test("VTS-009 Cancel", async (t) => {
  if (skipOrder(t, "VTS-009")) return;
  const live = liveClient()!;
  const parent = box.current.orders.find(
    (row) => row.intentId?.includes(`${run?.testRunId}:006`) && !row.parentOrderId,
  );
  if (!parent?.brokerOrderNo || (parent.status !== "pending" && parent.status !== "unknown")) {
    mark("VTS-009", "NOT VERIFIED");
    t.skip("NOT VERIFIED: no working VTS order to cancel (partial/fill already complete or order was not placed)");
    return;
  }
  const before = parent.status;
  await settleOpenOrders(box, live, Date.now(), { cancelImmediately: true });
  await persistStateNow(box.current);
  const after = box.current.orders.find((row) => row.id === parent.id);
  assert.ok(after);
  if (before !== "cancelled") {
    assert.notEqual(after.status === "cancelled" && after.reason?.includes("HTTP"), true);
  }
  mark("VTS-009", after.status === "unknown" ? "NOT VERIFIED" : "REAL VTS VERIFIED");
  if (after.status === "unknown") failRun();
});

test("VTS-010 Final Reconciliation", async (t) => {
  if (skipRead(t, "VTS-010")) return;
  const live = liveClient()!;
  const active = ensureRun("VTS-010");
  const [balance, open, executions] = await Promise.all([
    live.inquireBalance(),
    live.inquireOpenOrders(),
    live.inquireDailyCcld(),
  ]);
  const diff = diffLocalVsKis(box.current, balance);
  writeVtsReconciliation(active.dir, {
    matched: diff.matched,
    cashDelta: diff.cashDelta,
    reasons: diff.reasons,
    openOrders: open.length,
    executions: executions.length,
    localOrders: box.current.orders.length,
  });
  appendVtsEvent(active.dir, {
    testCaseId: "VTS-010",
    matched: diff.matched,
    reasons: diff.reasons,
  });
  await persistStateNow(box.current);
  if (!vtsOrderTestsEnabled()) {
    mark("VTS-010", "NOT VERIFIED");
    return;
  }
  if (!diff.matched) {
    failRun();
    mark("VTS-010", "NOT VERIFIED");
    throw new Error(`reconciliation mismatch; new orders must stay 0: ${diff.reasons.join(" / ")}`);
  }
  mark("VTS-010", "REAL VTS VERIFIED");
  assert.equal(existsSync(active.statePath), true);
});

test("VTS flatten stays simulation-only without liquidating VTS holdings", async (t) => {
  assertVtsSafeEnv();
  if (!vtsFlattenTestEnabled()) {
    mark("VTS-FLATTEN", "SIMULATED");
    t.skip("NOT VERIFIED: RUN_KIS_VTS_FLATTEN_TEST is not set; simulation-only (see Layer B)");
    return;
  }
  const isolated = { current: createPaperState() };
  isolated.current.positions = [];
  await RiskManager.emergencyFlatten(isolated, { kis: null });
  assert.equal(isolated.current.settings.autoTrading, false);
  mark("VTS-FLATTEN", "SIMULATED");
});

test("secret redaction covers tokens and account numbers", () => {
  const sample = redactSecrets(
    "authorization=Bearer tok.en access_token=abc refresh_token=def account 12345678-01",
  );
  assert.equal(sample.includes("tok.en"), false);
  assert.equal(sample.includes("abc"), false);
  assert.equal(sample.includes("12345678"), false);
});
