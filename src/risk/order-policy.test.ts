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
  PAPER_ORDER_POLICY,
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

test("Test C: PAPER qty=2 is blocked", () => {
  const domestic = checkHardLimits(
    createPaperState(),
    { side: "buy", ticker: "005930", qty: 2, price: 70_000 },
    PAPER_ENV,
  );
  assert.match(domestic ?? "", /qty must be 1/);
  const qty = checkPaperOrderConstraints({ qty: 2, ticker: "005930", state: createPaperState() });
  assert.equal(qty.ok, false);
  const overseas = overseasOneShareEligibility({
    symbol: "AAPL",
    nativePrice: 10,
    usdOrderable: 100_000,
    fxRate: 1353.3,
    qty: 2,
    env: PAPER_ENV,
  });
  assert.equal(overseas.eligible, false);
  assert.match(overseas.reason, /qty must be 1/);
});

test("Test D: same intent submits one broker order", async () => {
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
    const first = await broker.buyMarket("005930", 70_000);
    const second = await broker.buyMarket("005930", 70_000);
    assert.equal(first.status === "rejected", false);
    assert.equal(client.orders.length, 1);
    assert.equal(second.orderId, first.orderId);
    const local = new OrderManager({ current: createPaperState() });
    const a = local.buy("cash", "005930", 1, 70_000, { intentId: "intent-dup" });
    const b = local.buy("cash", "005930", 1, 70_000, { intentId: "intent-dup" });
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
  const paper = checkPaperOrderConstraints({ qty: 1, ticker: "005930", state });
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

test("Test F: REAL / non-PAPER LIVE_TEST keep amount limits", () => {
  assert.equal(usesPaperOrderPolicy(REAL_ENV), false);
  assert.equal(activeOrderPolicy(REAL_ENV).id, REAL_ORDER_POLICY.id);
  assert.equal(REAL_ORDER_POLICY.enforceAmountCaps, true);
  assert.equal(DEFAULT_LIVE_TEST_CAPS.maxOrderKrw, 10_000);
  assert.equal(HARD_LIMITS.maxOrderKrw, 2_000_000);

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
