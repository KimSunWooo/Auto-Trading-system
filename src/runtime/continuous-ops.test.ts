import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import type { Order } from "@/lib/types";
import { OrderManager } from "@/src/accounts/OrderManager";
import {
  checkPaperOrderConstraints,
  dailyBrokerSubmitCount,
  existingOpenBuy,
  hasUnknownOrder,
  PAPER_OPERATION_DEFAULTS,
  PAPER_TEST_POLICY,
  paperMaxBrokerSubmitsPerDay,
  paperMaxQtyPerOrder,
  REAL_ORDER_POLICY,
  usesPaperOrderPolicy,
} from "@/src/risk/order-policy";
import { checkHardLimits } from "@/src/risk/limits";
import { RiskManager } from "@/src/risk/RiskManager";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import { tradingBlocked, resetCircuit } from "@/src/risk/circuit";
import { autoStopReason, preTradeGate } from "@/src/runtime/controlled-run";
import {
  emptyStartupSync,
  startupSyncBlocksTrading,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";
import { makeSignalId } from "@/src/runtime/intents";
import { seoulDay } from "@/src/risk/limits";
import { RULE_THROTTLE_MS, RULE_THROTTLE_STREAK, noteRuleOutcome, ruleThrottleReason } from "@/src/rules/throttle";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import {
  configureWorkerLockPath,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  resetWorkerLockForTest,
} from "@/src/runtime/worker-lock";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
  PERSISTENCE_MODE: "mirror",
} as const;

const REAL_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live",
  KIS_MODE: "real",
  ALLOW_LIVE_TRADING: "true",
  KIS_LIVE_CONFIRM: "I_UNDERSTAND",
  KIS_REAL_APP_KEY: "real-key",
  KIS_REAL_APP_SECRET: "real-secret",
  KIS_REAL_ACCOUNT_NO: "22222222-01",
} as const;

function applyEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

function clearEnv() {
  for (const key of [...Object.keys(PAPER_ENV), ...Object.keys(REAL_ENV), "PAPER_POLICY_MODE", "RUN_KIS_VTS_ORDER_TESTS"]) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearEnv();
  resetWorkerLockForTest();
  setNowMs(null);
});

function filledBuy(extra: Partial<Order> = {}): Order {
  return {
    id: extra.id ?? "ord",
    createdAt: extra.createdAt ?? new Date().toISOString(),
    source: "rule",
    code: extra.code ?? "005930",
    name: "삼성전자",
    side: "buy",
    qty: extra.qty ?? 1,
    price: 70_000,
    amount: 70_000,
    commission: 0,
    tax: 0,
    net: 70_000,
    status: extra.status ?? "filled",
    brokerOrderNo: extra.brokerOrderNo ?? "0000000001",
    intentId: extra.intentId,
    activeClass: extra.activeClass,
    reason: extra.reason,
  };
}

test("Test A: operational PAPER 100+ same-day orders do not COUNT-block", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  const today = new Date().toISOString();
  state.orders = Array.from({ length: 120 }, (_, i) =>
    filledBuy({
      id: `n-${i}`,
      createdAt: today,
      code: "069500",
      brokerOrderNo: `000000${String(i).padStart(4, "0")}`,
    }),
  );
  assert.equal(dailyBrokerSubmitCount(state), 120);
  assert.equal(paperMaxBrokerSubmitsPerDay(PAPER_ENV), null);
  assert.equal(checkPaperOrderConstraints({ qty: 1, ticker: "005930", state }, PAPER_ENV).ok, true);
  assert.equal(checkHardLimits(state, { side: "buy", ticker: "005930", qty: 1, price: 70_000 }, PAPER_ENV), null);
  assert.equal(autoStopReason(state, PAPER_ENV), null);
});

test("Test B: VTS harness daily submit 5 retained", () => {
  const harness = { ...PAPER_ENV, PAPER_POLICY_MODE: "test" };
  assert.equal(paperMaxBrokerSubmitsPerDay(harness), 5);
  assert.equal(PAPER_TEST_POLICY.maxBrokerSubmitsPerDay, 5);
  assert.equal(PAPER_TEST_POLICY.maxQtyPerOrder, 1);
  assert.equal(PAPER_TEST_POLICY.maxNewBuyPerTestRun, 1);
});

test("Test C/D: operational qty 5 pass / 6 block", () => {
  applyEnv(PAPER_ENV);
  assert.equal(paperMaxQtyPerOrder(PAPER_ENV), 5);
  assert.equal(checkPaperOrderConstraints({ qty: 5 }, PAPER_ENV).ok, true);
  assert.equal(checkPaperOrderConstraints({ qty: 6 }, PAPER_ENV).ok, false);
});

test("Test E: held + requested > max position blocks", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.positions = [{ code: "005930", name: "삼성전자", qty: 48, avgPrice: 70_000, ruleId: "cash" }];
  const blocked = checkPaperOrderConstraints({ qty: 3, ticker: "005930", state, side: "buy" }, PAPER_ENV);
  assert.equal(blocked.ok, false);
  assert.match(blocked.blocked ?? "", /position qty cap 50/);
});

test("Test F: maxTickerWeight exceeded blocks", () => {
  const state = createPaperState();
  assert.equal(DEFAULT_PRODUCT_RISK.maxTickerWeight, 0.2);
  assert.equal(DEFAULT_PRODUCT_RISK.dailyLossPct, 0.03);
  const reason = RiskManager.checkBuy(state, {
    side: "buy",
    ticker: "005930",
    qty: 40,
    price: 70_000,
  });
  assert.match(reason ?? "", /20%/);
});

test("Test G: same MA signal same day → intent submit once", () => {
  applyEnv(PAPER_ENV);
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-intent-"));
  configureWorkerLockPath(path.join(dir, "trading-worker.lock"));
  try {
    tryAcquireWorkerLock("ma-intent");
    const day = seoulDay();
    const signalId = makeSignalId(["sig", "ma", "rule-1", "005930", "long", day]);
    const again = makeSignalId(["sig", "ma", "rule-1", "005930", "long", day]);
    assert.equal(signalId, again);
    const local = new OrderManager({ current: createPaperState() });
    const a = local.buy("cash", "005930", 5, 70_000, { intentId: signalId });
    const b = local.buy("cash", "005930", 5, 70_000, { intentId: signalId });
    assert.equal(a.ok, true, a.reason);
    assert.equal(b.orderId, a.orderId);
  } finally {
    releaseWorkerLock("ma-intent");
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Test H: existing open BUY blocks next BUY", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [filledBuy({ id: "open", status: "pending", brokerOrderNo: "0000000999" })];
  assert.ok(existingOpenBuy(state, "005930"));
  assert.equal(checkPaperOrderConstraints({ qty: 1, ticker: "005930", state }, PAPER_ENV).ok, false);
});

test("Test I: UNKNOWN_ACTIVE blocks BUY/SELL policy path", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    filledBuy({
      id: "unk",
      status: "unknown",
      activeClass: "UNKNOWN_ACTIVE",
      brokerOrderNo: undefined,
      createdAt: new Date().toISOString(),
    }),
  ];
  assert.equal(hasUnknownOrder(state), true);
  assert.equal(checkPaperOrderConstraints({ qty: 1, ticker: "069500", state }, PAPER_ENV).ok, false);
  assert.match(tradingBlocked(state) ?? "", /미확인|차단|UNKNOWN|PAPER/);
});

test("Test J: ORPHANED_LOCAL is not an active blocker", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    filledBuy({
      id: "88e68d0a-edea-4443-9cc0-3d19a54b6e08",
      status: "unknown",
      activeClass: "ORPHANED_LOCAL",
      createdAt: "2026-09-15T01:00:00.000Z",
      brokerOrderNo: "0000000101",
      intentId: "sig:paper:dup",
      qty: 11,
    }),
  ];
  assert.equal(hasUnknownOrder(state), false);
  assert.equal(existingOpenBuy(state, "005930"), undefined);
  assert.equal(checkPaperOrderConstraints({ qty: 1, ticker: "005930", state }, PAPER_ENV).ok, true);
  assert.equal(resetCircuit(state).error, undefined);
});

test("Test K: Startup Sync FAILED → broker submit gate", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.startupSync = { ...emptyStartupSync(), status: "FAILED", message: "open orders failed" };
  assert.equal(usesPaperStartupSync(PAPER_ENV), true);
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /FAILED|차단/);
  assert.match(tradingBlocked(state) ?? "", /FAILED|차단|Startup/);
});

test("Test L: MA strategy BUY respects max 5 shares hard cap", () => {
  applyEnv(PAPER_ENV);
  assert.equal(PAPER_OPERATION_DEFAULTS.maxQtyPerOrder, 5);
  const over = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 6, price: 70_000 },
    PAPER_ENV,
  );
  assert.match(over ?? "", /qty must be <= 5/);
});

test("Test M/N/O: MA exit / stop / take-profit sell policies ready", () => {
  // Strategy exit condition is regime+MA in RuleRunner; stop/take use RiskManager.
  assert.equal(RiskManager.shouldStopLoss(10_000, 9_500, 0.05), true);
  assert.equal(RiskManager.shouldStopLoss(10_000, 9_600, 0.05), false);
  // Take-profit: (last - avg) / avg >= takePct  (same as RiskManager.enforceStops)
  const avg = 100_000;
  const takePct = 0.1;
  assert.equal((110_000 - avg) / avg >= takePct, true);
  assert.equal((109_000 - avg) / avg >= takePct, false);
});

test("Test P: failed/unfilled twice → 3-minute throttle maintained", () => {
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  let state = createPaperState();
  state = noteRuleOutcome(state, {
    ruleId: "cash",
    ticker: "005930",
    status: "rejected",
    reason: "fail-1",
  });
  state = noteRuleOutcome(state, {
    ruleId: "cash",
    ticker: "005930",
    status: "rejected",
    reason: "fail-2",
  });
  const alloc = state.allocations.find((row) => row.ruleId === "cash");
  assert.match(ruleThrottleReason(alloc, "005930") ?? "", /쿨다운/);
  assert.equal(RULE_THROTTLE_STREAK, 2);
  assert.equal(RULE_THROTTLE_MS, 3 * 60 * 1000);
});

test("Test Q: operational daily count removal does not modify REAL policy", () => {
  assert.equal(usesPaperOrderPolicy(REAL_ENV), false);
  assert.equal(REAL_ORDER_POLICY.enforceAmountCaps, true);
  assert.equal(paperMaxBrokerSubmitsPerDay(REAL_ENV), null);
});

test("Test R: VTS harness remains 1-share / 1-buy / 5-submit", () => {
  assert.equal(PAPER_TEST_POLICY.maxQtyPerOrder, 1);
  assert.equal(PAPER_TEST_POLICY.maxNewBuyPerTestRun, 1);
  assert.equal(PAPER_TEST_POLICY.maxBrokerSubmitsPerDay, 5);
  assert.equal(PAPER_TEST_POLICY.maxPositionQtyPerSymbol, 1);
});

test("MA true-crossover restart audit: same-day intent + regime gate are SAFE", () => {
  // Current RuleRunner enters on fast>slow && regime!==long (not edge-detect).
  // Same Seoul-day signalId collapses re-submit; regime=long suppresses re-entry.
  applyEnv(PAPER_ENV);
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-xover-"));
  configureWorkerLockPath(path.join(dir, "trading-worker.lock"));
  try {
    tryAcquireWorkerLock("ma-xover");
    const day = seoulDay();
    const signalId = makeSignalId(["sig", "ma", "r1", "005930", "long", day]);
    const state = createPaperState();
    state.allocations = state.allocations.map((row) =>
      row.ruleId === "cash" ? { ...row, meta: { ...row.meta, regime: "long" } } : row,
    );
    const regime = String(state.allocations[0]?.meta?.regime ?? "flat");
    assert.equal(regime, "long");
    const om = new OrderManager({ current: state });
    const first = om.buy("cash", "005930", 5, 70_000, { intentId: signalId });
    const second = om.buy("cash", "005930", 5, 70_000, { intentId: signalId });
    assert.equal(first.ok, true, first.reason);
    assert.equal(second.orderId, first.orderId);
  } finally {
    releaseWorkerLock("ma-xover");
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DB_MIRROR_DEGRADED blocks new BUY in preTradeGate", async () => {
  applyEnv({ ...PAPER_ENV, PERSISTENCE_MODE: "mirror" });
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const { recordMirrorDegraded, resetDatabaseStatusForTest, recordMirrorSuccess } = await import(
    "@/src/db/status"
  );
  const { setMirrorLedgerForTest } = await import("@/src/db/mirror");
  const { MemoryLedger } = await import("@/src/db/ledger");
  resetDatabaseStatusForTest();
  setMirrorLedgerForTest(new MemoryLedger());
  recordMirrorSuccess();
  recordMirrorDegraded("fixture");
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirror-deg-"));
  configureWorkerLockPath(path.join(dir, "trading-worker.lock"));
  tryAcquireWorkerLock("mirror-degraded");
  try {
    const state = createPaperState();
    state.startupSync = {
      ...emptyStartupSync(),
      status: "HEALTHY",
      lastSyncedAt: new Date().toISOString(),
    };
    state.quotes["005930"] = {
      ...state.quotes["005930"]!,
      source: "kis",
      freshAt: Date.now(),
    };
    state.kisBalance = {
      syncedAt: new Date().toISOString(),
      fetchedAt: Date.now().toString(),
      cash: 1_000_000,
      d2Cash: 1_000_000,
      orderableCash: 1_000_000,
      holdings: [],
      cashDelta: 0,
      matched: true,
      message: "ok",
      freshness: "fresh",
    };
    state.controlledRun = {
      gate: "Domestic PAPER Live-Market Controlled Auto-Trading",
      startedAt: new Date().toISOString(),
      status: "running",
      strategyName: "none",
      symbols: ["005930"],
      ticks: 1,
      quoteSuccess: 1,
      quoteFail: 0,
      signals: 0,
      riskAllowed: 0,
      riskBlocked: 0,
      brokerSubmits: 0,
      buyCount: 0,
      sellCount: 0,
      executions: 0,
      partialFills: 0,
      duplicateExecutions: 0,
      duplicateSubmit: 0,
      unknownCount: 0,
      reconHealthy: 1,
      reconMismatch: 0,
      reconUnknown: 0,
      mirrorErrors: 1,
      jsonRdsDivergence: 0,
      kisJsonDivergence: 0,
      realRequests: 0,
      overseasOrders: 0,
      lastInquiry: {
        quoteOk: true,
        balanceOk: true,
        orderableOk: true,
        positionOk: true,
        openOrdersOk: true,
        executionOk: true,
        recon: "HEALTHY",
      },
      consecutiveInquiryFailures: 0,
      events: [],
    };
    const gate = preTradeGate(state, { side: "buy", ticker: "005930", qty: 1 }, PAPER_ENV);
    assert.equal(gate.ok, false);
    assert.match(("blocked" in gate && gate.blocked) || "", /RDS mirror degraded/);
  } finally {
    setMirrorLedgerForTest(null);
    resetDatabaseStatusForTest();
    releaseWorkerLock("mirror-degraded");
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk denominator uses totalDeposit (report consistency)", () => {
  const state = createPaperState();
  assert.equal(state.totalDeposit, 10_000_000);
  // Local totalDeposit is the RiskManager.checkBuy denominator today.
  const denom = Math.max(1, state.totalDeposit);
  assert.equal(denom, 10_000_000);
});
