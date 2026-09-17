import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import type { AppState, Order } from "@/lib/types";
import { OrderManager } from "@/src/accounts/OrderManager";
import { KisBroker } from "@/src/brokers/KisBroker";
import type {
  KisAccountBalance,
  KisApi,
  KisCancelOrder,
  KisCashOrder,
  KisDayOrder,
  KisPrice,
} from "@/src/brokers/kis-client";
import { checkHardLimits, HARD_LIMITS } from "@/src/risk/limits";
import {
  activeOrderPolicy,
  checkPaperOrderConstraints,
  dailyBrokerSubmitCount,
  PAPER_ORDER_POLICY,
  PAPER_OPERATION_DEFAULTS,
  PAPER_TEST_POLICY,
  paperMaxBrokerSubmitsPerDay,
  paperMaxQtyPerOrder,
  paperOperationPolicy,
  parsePositiveIntEnv,
  REAL_ORDER_POLICY,
  usesPaperOrderPolicy,
} from "@/src/risk/order-policy";
import { overseasOneShareEligibility, overseasVtsBPreflight } from "@/src/markets/overseas/preflight";
import { DEFAULT_LIVE_TEST_CAPS, liveTestCaps } from "@/src/runtime/trading-mode";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import {
  configureWorkerLockPath,
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
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

function pendingBuy(code: string, extra: Partial<Order> = {}): Order {
  return {
    id: extra.id ?? "open-buy-1",
    createdAt: extra.createdAt ?? new Date().toISOString(),
    source: "rule",
    code,
    name: code,
    side: "buy",
    qty: 1,
    price: 70_000,
    amount: 70_000,
    commission: 0,
    tax: 0,
    net: 70_000,
    status: "pending",
    ...extra,
  };
}

class FakeKis implements KisApi {
  mode: KisApi["mode"] = "paper";
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  orders: KisCashOrder[] = [];
  fills: KisDayOrder[] = [];
  open: KisDayOrder[] = [];
  cancels: KisCancelOrder[] = [];
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };

  async inquirePrice(ticker: string): Promise<KisPrice> {
    return {
      ticker,
      name: "삼성전자",
      price: 70_000,
      open: 70_000,
      high: 71_000,
      low: 69_000,
      prevClose: 69_500,
      volume: 1_000_000,
    };
  }
  async inquireDailyCloses(): Promise<number[]> {
    return Array.from({ length: 30 }, () => 70_000);
  }
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    return this.fills.map((row) => ({ ...row }));
  }
  async inquireOpenOrders(): Promise<KisDayOrder[]> {
    return this.open.map((row) => ({ ...row }));
  }
  async inquireBalance(): Promise<KisAccountBalance> {
    return { cash: this.balance.cash, d2Cash: this.balance.d2Cash, holdings: [] };
  }
  async orderCash(order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }> {
    this.orders.push(order);
    return { orderNo: `0000000${100 + this.orders.length}`, krxOrgNo: "06010" };
  }
  async cancelOrder(order: KisCancelOrder): Promise<void> {
    this.cancels.push(order);
  }
}

function applyEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function clearPolicyEnv() {
  for (const key of [
    "BROKER",
    "TRADING_MODE",
    "KIS_MODE",
    "ALLOW_LIVE_TRADING",
    "KIS_LIVE_CONFIRM",
    "LIVE_TEST_MAX_ORDER_KRW",
    "KIS_PAPER_APP_KEY",
    "KIS_PAPER_APP_SECRET",
    "KIS_PAPER_ACCOUNT_NO",
    "KIS_REAL_APP_KEY",
    "KIS_REAL_APP_SECRET",
    "KIS_REAL_ACCOUNT_NO",
    "PAPER_MAX_QTY_PER_ORDER",
    "PAPER_MAX_BROKER_SUBMITS_PER_DAY",
    "PAPER_MAX_POSITION_QTY_PER_SYMBOL",
    "PAPER_POLICY_MODE",
    "RUN_KIS_VTS_ORDER_TESTS",
    "RUN_KIS_VTS_OVERSEAS_ORDER_TESTS",
  ]) {
    delete process.env[key];
  }
}

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => {
  setNowMs(null);
  resetWorkerLockForTest();
  clearPolicyEnv();
});
afterEach(() => {
  resetWorkerLockForTest();
  clearPolicyEnv();
});

test("Test A: domestic PAPER 1 share above 10,000 KRW is not amount-blocked", () => {
  const reason = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 1, price: 70_000 },
    PAPER_ENV,
  );
  assert.equal(reason, null);
  assert.equal(usesPaperOrderPolicy(PAPER_ENV), true);
  assert.equal(activeOrderPolicy(PAPER_ENV).id, PAPER_ORDER_POLICY.id);
  assert.equal(PAPER_ORDER_POLICY.enforceAmountCaps, false);
});

test("Test B: overseas PAPER AAPL 1 share above 10,000 KRW is not amount-blocked", () => {
  const result = overseasOneShareEligibility({
    symbol: "AAPL",
    nativePrice: 331.44,
    usdOrderable: 100_000,
    fxRate: 1353.3,
    qty: 1,
    env: PAPER_ENV,
  });
  assert.equal(result.eligible, true);
  assert.ok((result.krwNotional ?? 0) > 10_000);
  const funded = overseasVtsBPreflight({
    env: { ...PAPER_ENV, RUN_KIS_VTS_OVERSEAS_ORDER_TESTS: "true" },
    quoteHealthy: true,
    foreignBalanceHealthy: true,
    reconciliationHealthy: true,
    marketStatus: "open",
    riskHealthy: true,
    usdCash: 0,
    usdOrderable: 100_000,
    nativePrice: 331.44,
    fxRate: 1353.3,
    qty: 1,
    symbol: "AAPL",
  });
  assert.equal(funded.ok, true);
  assert.equal(funded.instrumentEligible, true);
});

test("Test C: operational PAPER qty 1/5 pass, qty 6 blocked", () => {
  for (const qty of [1, 5]) {
    const domestic = checkHardLimits(
      createPaperState(),
      { side: "buy", ticker: "005930", qty, price: 70_000 },
      PAPER_ENV,
    );
    assert.equal(domestic, null, `qty=${qty}`);
    assert.equal(checkPaperOrderConstraints({ qty, ticker: "005930", state: createPaperState() }, PAPER_ENV).ok, true);
  }
  const blocked = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 6, price: 70_000 },
    PAPER_ENV,
  );
  assert.match(blocked ?? "", /qty must be <= 5/);
  const qty = checkPaperOrderConstraints({ qty: 6, ticker: "005930", state: createPaperState() }, PAPER_ENV);
  assert.equal(qty.ok, false);
  const overseas5 = overseasOneShareEligibility({
    symbol: "AAPL",
    nativePrice: 10,
    usdOrderable: 100_000,
    fxRate: 1353.3,
    qty: 5,
    env: PAPER_ENV,
  });
  assert.equal(overseas5.eligible, true);
  const overseas6 = overseasOneShareEligibility({
    symbol: "AAPL",
    nativePrice: 10,
    usdOrderable: 100_000,
    fxRate: 1353.3,
    qty: 6,
    env: PAPER_ENV,
  });
  assert.equal(overseas6.eligible, false);
  assert.match(overseas6.reason, /qty must be <= 5/);
});

test("Test D: same intent qty=5 submits one broker order", async () => {
  applyEnv(PAPER_ENV);
  const dir = mkdtempSync(path.join(os.tmpdir(), "paper-dup-"));
  configureWorkerLockPath(path.join(dir, "trading-worker.lock"));
  try {
    tryAcquireWorkerLock("paper-dup-intent");
    const box = { current: createPaperState() };
    const client = new FakeKis();
    const broker = new KisBroker(box, client, "cash").withIntent({
      intentId: "sig:paper:dup",
      signalId: "sig:paper:dup",
    });
    const first = await broker.buyMarket("005930", 70_000 * 5);
    const second = await broker.buyMarket("005930", 70_000 * 5);
    assert.equal(first.status === "rejected", false);
    assert.equal(client.orders.length, 1);
    assert.equal(second.orderId, first.orderId);
    const local = new OrderManager({ current: createPaperState() });
    const a = local.buy("cash", "005930", 5, 70_000, { intentId: "intent-dup" });
    const b = local.buy("cash", "005930", 5, 70_000, { intentId: "intent-dup" });
    assert.equal(a.ok, true);
    assert.equal(b.orderId, a.orderId);
  } finally {
    releaseWorkerLock("paper-dup-intent");
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Test E: existing open BUY blocks a new order", () => {
  const state: AppState = createPaperState();
  state.orders = [pendingBuy("005930")];
  const paper = checkPaperOrderConstraints({ qty: 1, ticker: "005930", state }, PAPER_ENV);
  assert.equal(paper.ok, false);
  assert.match(paper.blocked ?? "", /Existing open BUY order detected/);
  const hard = checkHardLimits(
    state,
    { side: "buy", ticker: "005930", qty: 1, price: 70_000 },
    PAPER_ENV,
  );
  assert.match(hard ?? "", /Existing open BUY order detected/);
  applyEnv(PAPER_ENV);
  tryAcquireWorkerLock("paper-open-buy");
  const fill = new OrderManager({ current: state }).buy("cash", "005930", 1, 70_000, {
    intentId: "sig:new",
  });
  assert.equal(fill.ok, false);
  assert.equal(state.orders.filter((row) => !row.parentOrderId).length, 1);
  const overseas = overseasVtsBPreflight({
    env: { ...PAPER_ENV, RUN_KIS_VTS_OVERSEAS_ORDER_TESTS: "true" },
    quoteHealthy: true,
    foreignBalanceHealthy: true,
    reconciliationHealthy: true,
    marketStatus: "open",
    riskHealthy: true,
    usdCash: 0,
    usdOrderable: 100_000,
    nativePrice: 331.44,
    fxRate: 1353.3,
    qty: 1,
    symbol: "AAPL",
    existingOpenBuy: true,
  });
  assert.equal(overseas.ok, false);
  assert.match(overseas.blocked ?? "", /Existing open BUY order detected/);
  releaseWorkerLock("paper-open-buy");
});

test("Test F: operational PAPER has no daily COUNT cap; harness keeps 5", () => {
  assert.equal(paperMaxBrokerSubmitsPerDay(PAPER_ENV), null);
  assert.equal(paperOperationPolicy(PAPER_ENV).maxBrokerSubmitsPerDay, null);
  const state = createPaperState();
  const today = new Date().toISOString();
  state.orders = Array.from({ length: 100 }, (_, i) =>
    pendingBuy("005930", {
      id: `d-${i}`,
      status: "filled",
      createdAt: today,
      code: `00${1000 + i}`.slice(-6),
    }),
  );
  assert.equal(dailyBrokerSubmitCount(state), 100);
  assert.equal(
    checkPaperOrderConstraints({ qty: 1, ticker: "069500", state }, PAPER_ENV).ok,
    true,
  );
  assert.equal(checkHardLimits(state, { side: "buy", ticker: "069500", qty: 1, price: 70_000 }, PAPER_ENV), null);

  const harnessEnv = { ...PAPER_ENV, PAPER_POLICY_MODE: "test" };
  assert.equal(paperMaxBrokerSubmitsPerDay(harnessEnv), 5);
  const harnessState = createPaperState();
  // Use sells so maxNewBuyPerTestRun does not fire before the daily COUNT check.
  harnessState.orders = Array.from({ length: 5 }, (_, i) =>
    pendingBuy("005930", {
      id: `h-${i}`,
      status: "filled",
      createdAt: today,
      side: "sell",
      brokerOrderNo: `000000${1000 + i}`,
    }),
  );
  const harnessBlocked = checkPaperOrderConstraints(
    { qty: 1, ticker: "069500", state: harnessState },
    harnessEnv,
  );
  assert.equal(harnessBlocked.ok, false);
  assert.match(harnessBlocked.blocked ?? "", /daily order cap 5/);
});

test("Test G: PAPER position qty limit", () => {
  const state = createPaperState();
  state.positions = [{ code: "005930", name: "삼성전자", qty: 46, avgPrice: 70_000, ruleId: "cash" }];
  assert.equal(
    checkPaperOrderConstraints({ qty: 4, ticker: "005930", state, side: "buy" }, PAPER_ENV).ok,
    true,
  );
  const over = checkPaperOrderConstraints({ qty: 5, ticker: "005930", state, side: "buy" }, PAPER_ENV);
  assert.equal(over.ok, false);
  assert.match(over.blocked ?? "", /position qty cap 50/);
});

test("Test H: REAL policy unchanged by PAPER env", () => {
  assert.equal(usesPaperOrderPolicy(REAL_ENV), false);
  assert.equal(activeOrderPolicy(REAL_ENV).id, REAL_ORDER_POLICY.id);
  assert.equal(REAL_ORDER_POLICY.enforceAmountCaps, true);
  assert.equal(DEFAULT_LIVE_TEST_CAPS.maxOrderKrw, 10_000);
  assert.equal(HARD_LIMITS.maxOrderKrw, 2_000_000);
  assert.equal(paperOperationPolicy({ ...REAL_ENV, PAPER_MAX_QTY_PER_ORDER: "5" }).maxQtyPerOrder, 5);
  assert.equal(usesPaperOrderPolicy({ ...REAL_ENV, PAPER_MAX_QTY_PER_ORDER: "5" }), false);

  const liveTestOnly = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 1, price: 70_000 },
    { TRADING_MODE: "live_test" },
  );
  assert.match(liveTestOnly ?? "", /10,000|10000/);

  const liveTestRealMode = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 1, price: 70_000 },
    { ...PAPER_ENV, KIS_MODE: "real", ALLOW_LIVE_TRADING: "true", KIS_LIVE_CONFIRM: "I_UNDERSTAND" },
  );
  assert.equal(usesPaperOrderPolicy({ ...PAPER_ENV, KIS_MODE: "real" }), false);
  assert.match(liveTestRealMode ?? "", /한도/);

  const oversizedReal = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 50, price: 70_000 },
    REAL_ENV,
  );
  assert.ok(oversizedReal);
  assert.ok(50 * 70_000 > HARD_LIMITS.maxOrderKrw);

  applyEnv({
    TRADING_MODE: "live_test",
    LIVE_TEST_MAX_ORDER_KRW: "2000000",
  });
  const caps = liveTestCaps();
  assert.equal(caps.maxOrderKrw, 10_000);
  const raised = checkHardLimits(createPaperState(), {
    side: "buy",
    ticker: "005930",
    qty: 1,
    price: 70_000,
  });
  assert.match(raised ?? "", /10,000|10000/);

  const aaplReal = overseasOneShareEligibility({
    symbol: "AAPL",
    nativePrice: 331.44,
    usdOrderable: 100_000,
    fxRate: 1353.3,
    qty: 1,
    env: REAL_ENV,
  });
  assert.equal(aaplReal.eligible, false);
  assert.match(aaplReal.reason, /risk limit/);
});

test("PAPER env qty defaults and rejects non-positive", () => {
  assert.equal(paperMaxQtyPerOrder(PAPER_ENV), 5);
  assert.equal(PAPER_OPERATION_DEFAULTS.maxQtyPerOrder, 5);
  assert.equal(PAPER_OPERATION_DEFAULTS.maxBrokerSubmitsPerDay, null);
  assert.equal(parsePositiveIntEnv(undefined, 5).value, 5);
  assert.equal(parsePositiveIntEnv("0", 5).rejected, true);
  assert.equal(parsePositiveIntEnv("-1", 5).rejected, true);
  assert.equal(parsePositiveIntEnv("NaN", 5).rejected, true);
  assert.equal(parsePositiveIntEnv("Infinity", 5).rejected, true);
  const bad = checkPaperOrderConstraints(
    { qty: 1, ticker: "005930", state: createPaperState() },
    { ...PAPER_ENV, PAPER_MAX_QTY_PER_ORDER: "0" },
  );
  assert.equal(bad.ok, false);
  assert.match(bad.blocked ?? "", /invalid PAPER_MAX_QTY_PER_ORDER/);
  assert.equal(activeOrderPolicy({ ...PAPER_ENV, PAPER_POLICY_MODE: "test" }).id, PAPER_TEST_POLICY.id);
  assert.equal(paperMaxQtyPerOrder({ ...PAPER_ENV, PAPER_POLICY_MODE: "test" }), 1);
});

test("operational PAPER removes maxNewBuyPerTestRun; harness keeps it", () => {
  const state = createPaperState();
  state.controlledRun = {
    gate: "Domestic PAPER Live-Market Controlled Auto-Trading",
    startedAt: "2026-09-17T00:00:00.000Z",
    status: "running",
    strategyName: "none",
    symbols: ["005930"],
    ticks: 0,
    quoteSuccess: 0,
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
    reconHealthy: 0,
    reconMismatch: 0,
    reconUnknown: 0,
    mirrorErrors: 0,
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
  state.orders = [
    pendingBuy("005930", {
      id: "session-buy",
      status: "filled",
      createdAt: "2026-09-17T01:00:00.000Z",
    }),
  ];
  assert.equal(
    checkPaperOrderConstraints({ qty: 1, ticker: "069500", state }, PAPER_ENV).ok,
    true,
  );
  const harness = checkPaperOrderConstraints(
    { qty: 1, ticker: "069500", state },
    { ...PAPER_ENV, PAPER_POLICY_MODE: "test" },
  );
  assert.equal(harness.ok, false);
  assert.match(harness.blocked ?? "", /maxNewBuyPerTestRun/);
});