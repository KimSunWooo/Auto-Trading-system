import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { createPaperState, tickState } from "@/lib/engine";
import { hydratePersistedState } from "@/lib/store";
import { OrderManager } from "@/src/accounts/OrderManager";
import { MockBroker } from "@/src/brokers/MockBroker";
import { KisBroker } from "@/src/brokers/KisBroker";
import type {
  KisApi,
  KisAccountBalance,
  KisCancelOrder,
  KisCashOrder,
  KisDayOrder,
  KisPrice,
} from "@/src/brokers/kis-client";
import { setSharedKisClientForTest } from "@/src/brokers/kis-client";
import { tradingBlocked } from "@/src/risk/circuit";
import { checkHardLimits } from "@/src/risk/limits";
import { RiskManager } from "@/src/risk/RiskManager";
import { recoverExternalOrders } from "@/src/runtime/recovery";
import { readJsonWithBackup, writeJsonAtomic } from "@/src/runtime/atomic-file";
import { httpTickAllowed, liveTestCaps, tradingMode } from "@/src/runtime/trading-mode";
import { makeSignalId, manualIntentId } from "@/src/runtime/intents";
import {
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
  releaseWorkerLock,
} from "@/src/runtime/worker-lock";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => {
  setNowMs(null);
  setSharedKisClientForTest(null);
  resetWorkerLockForTest();
});
afterEach(() => {
  delete process.env.TRADING_MODE;
  delete process.env.MOCK_BROKER_MODE;
  delete process.env.BROKER;
  delete process.env.ALLOW_LIVE_TRADING;
  resetWorkerLockForTest();
  setSharedKisClientForTest(null);
});

function fakePrice(ticker: string, price = 70_000): KisPrice {
  return {
    ticker,
    name: "삼성전자",
    price,
    open: price,
    high: price + 1000,
    low: price - 1000,
    prevClose: price - 500,
    volume: 1_000_000,
  };
}

class FakeKis implements KisApi {
  mode: KisApi["mode"] = "demo";
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  orders: KisCashOrder[] = [];
  fills: KisDayOrder[] = [];
  open: KisDayOrder[] = [];
  cancels: KisCancelOrder[] = [];
  failQuote = false;
  failBalance = false;
  failCcld = false;
  failOpen = false;
  failOrder: Error | null = null;
  autoFill = false;
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };

  async inquirePrice(ticker: string): Promise<KisPrice> {
    if (this.failQuote) throw new Error("quote down");
    return fakePrice(ticker);
  }
  async inquireDailyCloses(): Promise<number[]> {
    if (this.failQuote) throw new Error("quote down");
    return Array.from({ length: 30 }, () => 70_000);
  }
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    if (this.failCcld) throw new Error("execution down");
    return this.fills.map((row) => ({ ...row }));
  }
  async inquireOpenOrders(): Promise<KisDayOrder[]> {
    if (this.failOpen) throw new Error("open orders down");
    return (this.open.length ? this.open : this.fills.filter((row) => row.unfilledQty > 0)).map(
      (row) => ({ ...row }),
    );
  }
  async inquireBalance(): Promise<KisAccountBalance> {
    if (this.failBalance) throw new Error("balance down");
    return {
      cash: this.balance.cash,
      d2Cash: this.balance.d2Cash,
      holdings: this.balance.holdings.map((row) => ({ ...row })),
    };
  }
  async orderCash(order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }> {
    if (this.failOrder) throw this.failOrder;
    this.orders.push(order);
    const orderNo = `0000000${100 + this.orders.length}`;
    if (this.autoFill) {
      this.fills.push({
        orderNo,
        ticker: order.ticker,
        side: order.side,
        qty: order.qty,
        filledQty: order.qty,
        unfilledQty: 0,
        avgPrice: 70_000,
      });
    }
    return { orderNo, krxOrgNo: "06010" };
  }
  async cancelOrder(order: KisCancelOrder): Promise<void> {
    this.cancels.push(order);
  }
}

test("1. 동일 signalId → 주문 1회", async () => {
  const box = { current: createPaperState() };
  const broker = new MockBroker(box, "cash").withIntent({
    intentId: "sig:interval:r1:005930:1",
    signalId: "sig:interval:r1:005930:1",
  });
  const first = await broker.buyMarket("005930", 140_000);
  const second = await broker.buyMarket("005930", 140_000);
  assert.equal(first.ok, true);
  assert.equal(second.orderId, first.orderId);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, 1);
});

test("2. 동일 intentId → 주문 1회", async () => {
  const box = { current: createPaperState() };
  const orders = new OrderManager(box);
  const a = orders.buy("cash", "005930", 1, 70_000, { intentId: "intent-dup" });
  const b = orders.buy("cash", "005930", 1, 70_000, { intentId: "intent-dup" });
  assert.equal(a.ok, true);
  assert.equal(b.orderId, a.orderId);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId && row.status === "filled").length, 1);
});

test("3. timeout → UNKNOWN", async () => {
  process.env.MOCK_BROKER_MODE = "timeout";
  const box = { current: createPaperState() };
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.status, "unknown");
  assert.match(tradingBlocked(box.current) ?? "", /미확인|확인하지/);
});

test("4. UNKNOWN → 자동 재주문 금지", async () => {
  process.env.MOCK_BROKER_MODE = "timeout";
  const box = { current: createPaperState() };
  const broker = new MockBroker(box, "cash").withIntent({ intentId: "sig:once" });
  await broker.buyMarket("005930", 140_000);
  process.env.MOCK_BROKER_MODE = "instant";
  const again = await broker.buyMarket("005930", 140_000);
  assert.equal(again.status, "unknown");
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, 1);
  const other = await new MockBroker(box, "cash").withIntent({ intentId: "sig:other" }).buyMarket("005930", 140_000);
  assert.equal(other.ok, false);
  assert.match(other.reason ?? "", /미확인|확인하지|서킷/);
});

test("5. KIS quote 실패 → 주문 금지", async () => {
  process.env.TRADING_MODE = "live_test";
  tryAcquireWorkerLock("test-quote");
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.failQuote = true;
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  assert.match(fill.reason ?? "", /시세|quote/i);
  releaseWorkerLock("test-quote");
});

test("6. balance 조회 실패 → 주문 금지", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  tryAcquireWorkerLock("test-bal");
  const client = new FakeKis();
  client.failBalance = true;
  setSharedKisClientForTest(client);
  const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
  assert.match(tradingBlocked(next) ?? "", /잔고|조회|증권사|balance/i);
  const fill = await new KisBroker({ current: next }, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("test-bal");
});

test("7. execution 조회 실패 → 주문 금지", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  tryAcquireWorkerLock("test-exec");
  const client = new FakeKis();
  client.failCcld = true;
  client.failOpen = true;
  setSharedKisClientForTest(client);
  const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
  assert.match(tradingBlocked(next) ?? "", /조회|체결|미체결|대조|open orders/i);
  const fill = await new KisBroker({ current: next }, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("test-exec");
});

test("8. reconciliation 실패 → 주문 금지", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  tryAcquireWorkerLock("test-recon");
  const client = new FakeKis();
  client.failOpen = true;
  setSharedKisClientForTest(client);
  const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
  assert.equal(next.safety?.kind, "reconciliation_unavailable");
  assert.ok(tradingBlocked(next));
  releaseWorkerLock("test-recon");
});

test("9. 외부 KIS 주문 발견 → local recovery", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.open = [
    {
      orderNo: "555",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 70_000,
    },
  ];
  const recovered = await recoverExternalOrders(box, client);
  assert.equal(recovered.ok, true);
  const local = box.current.orders.find((row) => row.brokerOrderNo && /555/.test(row.brokerOrderNo));
  assert.ok(local);
  assert.match(local?.reason ?? "", /RECOVERED_ORDER/);
});

test("10. 서버 재시작 → 상태 recovery, duplicate 없음", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.open = [
    {
      orderNo: "777",
      ticker: "005930",
      side: "buy",
      qty: 1,
      filledQty: 0,
      unfilledQty: 1,
      avgPrice: 70_000,
    },
  ];
  await recoverExternalOrders(box, client);
  const first = box.current.orders.filter((row) => !row.parentOrderId).length;
  await recoverExternalOrders(box, client);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, first);
});

test("11. 손절 후 같은 tick 재매수 금지", async () => {
  const state = createPaperState();
  const quote = state.quotes["005930"]!;
  quote.price = 70_000;
  quote.prevClose = 70_000;
  state.positions = [{ code: "005930", name: "삼성전자", qty: 2, avgPrice: 80_000, ruleId: "cash" }];
  state.allocations = state.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: row.balance - 160_000 } : row,
  );
  state.cash = state.allocations.reduce((sum, row) => sum + row.balance, 0);
  const box = { current: state };
  await new RiskManager(box).enforceStops();
  const buy = new OrderManager(box).buy("cash", "005930", 1, 70_000);
  assert.equal(buy.ok, false);
  assert.match(buy.reason ?? "", /손절/);
});

test("12. Kill Switch → 신규 주문 금지", async () => {
  const box = { current: createPaperState() };
  await RiskManager.emergencyStop(box, { kis: null });
  const buy = new OrderManager(box).buy("cash", "005930", 1, 70_000);
  assert.equal(buy.ok, false);
  assert.match(buy.reason ?? "", /긴급|안전|정지|서킷/);
});

test("13. Worker lock 중복 실행 방지", () => {
  const filePath = path.join(tmpdir(), `lock-${process.pid}-${Date.now()}.lock`);
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("worker-a", { filePath }), true);
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("worker-b", { filePath }), false);
  resetWorkerLockForTest();
  releaseWorkerLock("worker-a");
});

test("13b. lock 없는 LIVE_TEST 워커는 주문 금지", () => {
  process.env.TRADING_MODE = "live_test";
  resetWorkerLockForTest();
  const box = { current: createPaperState() };
  const buy = new OrderManager(box).buy("cash", "005930", 1, 70_000);
  assert.equal(buy.ok, false);
  assert.match(buy.reason ?? "", /워커 락/);
});

test("14. corrupted JSON → 초기화하지 않고 recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "persist-"));
  const primary = path.join(dir, "paper.json");
  await writeFile(primary, "{not-json", "utf8");
  const loaded = await readJsonWithBackup(primary);
  assert.equal(loaded.ok, false);
  const state = hydratePersistedState({ ok: false, reason: "corrupt" });
  assert.equal(state.safety?.kind, "store_corrupt");
  assert.equal(state.safety?.persistable, false);
  assert.equal(state.settings.autoTrading, false);
  assert.ok(tradingBlocked(state));
});

test("15. Mock instant → 기존처럼 정상 체결", async () => {
  process.env.MOCK_BROKER_MODE = "instant";
  const box = { current: createPaperState() };
  const before = box.current.cash;
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, true);
  assert.equal(fill.status, "filled");
  assert.ok(box.current.cash < before);
  assert.ok(box.current.positions.some((row) => row.code === "005930"));
});

test("16. Mock delayed → pending 처리", async () => {
  process.env.MOCK_BROKER_MODE = "delayed";
  const box = { current: createPaperState() };
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.status, "pending");
  assert.equal(box.current.positions.length, 0);
});

test("17. Mock partial → partial fill 처리", async () => {
  process.env.MOCK_BROKER_MODE = "partial";
  const box = { current: createPaperState() };
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 280_000);
  assert.ok((fill.qty ?? 0) >= 1);
  const parent = box.current.orders.find((row) => !row.parentOrderId);
  assert.ok(parent);
  assert.ok((parent?.filledQty ?? 0) > 0);
  assert.ok((parent?.filledQty ?? 0) < (parent?.orderedQty ?? parent?.qty ?? 0));
});

test("18. Mock timeout → unknown 처리", async () => {
  process.env.MOCK_BROKER_MODE = "timeout";
  const box = { current: createPaperState() };
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.status, "unknown");
});

test("19. Risk limit 초과 → 주문 생성 금지", () => {
  const state = createPaperState();
  const reason = checkHardLimits(state, { side: "buy", ticker: "005930", qty: 50, price: 70_000 });
  assert.ok(reason);
  const box = { current: state };
  const fill = new OrderManager(box).buy("cash", "005930", 50, 70_000);
  assert.equal(fill.ok, false);
  assert.equal(box.current.orders.filter((row) => row.status === "filled").length, 0);
});

test("20. LIVE_TEST에서 limit 초과 → 주문 생성 금지", () => {
  process.env.TRADING_MODE = "live_test";
  tryAcquireWorkerLock("test-live-cap");
  const state = createPaperState();
  const reason = checkHardLimits(state, { side: "buy", ticker: "005930", qty: 1, price: 70_000 });
  assert.match(reason ?? "", /한도/);
  const fill = new OrderManager({ current: state }).buy("cash", "005930", 1, 70_000);
  assert.equal(fill.ok, false);
  releaseWorkerLock("test-live-cap");
});

test("SCENARIO 1 정상 매수 Quote→Fill→Position→Balance", async () => {
  const box = { current: createPaperState() };
  const quote = box.current.quotes["005930"];
  assert.ok(quote);
  const before = box.current.cash;
  const fill = await new MockBroker(box, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, true);
  assert.ok(box.current.positions[0]?.qty);
  assert.ok(box.current.cash < before);
});

test("SCENARIO 2 주문 timeout → UNKNOWN → 재주문 차단 → reconciliation", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  client.failOrder = timeout;
  const first = await new KisBroker(box, client, "cash").withIntent({ intentId: "sig:to" }).buyMarket(
    "005930",
    140_000,
  );
  assert.equal(first.status, "unknown");
  client.failOrder = null;
  client.open = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 70_000,
    },
  ];
  const second = await new KisBroker(box, client, "cash").withIntent({ intentId: "sig:to" }).buyMarket(
    "005930",
    140_000,
  );
  assert.equal(client.orders.length, 0);
  assert.equal(second.status, "unknown");
  await recoverExternalOrders(box, client);
  const recovered = box.current.orders.some((row) => row.brokerOrderNo && /123/.test(row.brokerOrderNo ?? ""));
  assert.equal(recovered, true);
});

test("SCENARIO 3 crash 후 KIS 주문 조회 → local recovery", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.open = [
    {
      orderNo: "999",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 70_000,
    },
  ];
  await recoverExternalOrders(box, client);
  const count = box.current.orders.filter((row) => !row.parentOrderId).length;
  const fill = await new KisBroker(box, client, "cash")
    .withIntent({ intentId: "recovered:999" })
    .buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, count);
});

test("SCENARIO 4 KIS quote failure → 주문 없음", async () => {
  process.env.TRADING_MODE = "live_test";
  tryAcquireWorkerLock("s4");
  const client = new FakeKis();
  client.failQuote = true;
  const box = { current: createPaperState() };
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("s4");
});

test("SCENARIO 5 Reconciliation failure → strategy 중단", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  tryAcquireWorkerLock("s5");
  const client = new FakeKis();
  client.failBalance = true;
  setSharedKisClientForTest(client);
  const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
  assert.ok(tradingBlocked(next));
  assert.equal(next.orders.length, 0);
  releaseWorkerLock("s5");
});

test("SCENARIO 6 손절 후 same tick BUY 차단", async () => {
  const state = createPaperState();
  state.quotes["005930"]!.price = 70_000;
  state.positions = [{ code: "005930", name: "삼성전자", qty: 2, avgPrice: 80_000, ruleId: "cash" }];
  const box = { current: state };
  await new RiskManager(box).enforceStops();
  const buy = new OrderManager(box).buy("cash", "005930", 1, 70_000);
  assert.equal(buy.ok, false);
});

test("SCENARIO 7 두 Worker 동시 실행", () => {
  const filePath = path.join(tmpdir(), `wlock-${Date.now()}.lock`);
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("A", { filePath }), true);
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("B", { filePath }), false);
});

test("SCENARIO 8 동일 signal 10회 → intent 1 · broker order 1", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const broker = new KisBroker(box, client, "cash").withIntent({ intentId: "sig:ten" });
  for (let i = 0; i < 10; i += 1) {
    await broker.buyMarket("005930", 140_000);
  }
  assert.equal(client.orders.length, 1);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, 1);
});

test("atomic JSON write keeps the original file on success path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomic-"));
  const file = path.join(dir, "state.json");
  await writeJsonAtomic(file, { ok: true });
  const loaded = await readJsonWithBackup<{ ok: boolean }>(file);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value.ok, true);
});

test("http tick is allowed only in mock/paper", () => {
  assert.equal(httpTickAllowed("mock"), true);
  assert.equal(httpTickAllowed("paper"), true);
  assert.equal(httpTickAllowed("live_test"), false);
  assert.equal(httpTickAllowed("live"), false);
  assert.equal(tradingMode({ TRADING_MODE: "MOCK" }), "mock");
});

test("LIVE_TEST rejects real-host KisBroker orders", async () => {
  process.env.TRADING_MODE = "live_test";
  tryAcquireWorkerLock("vts-real-block");
  const client = new FakeKis();
  client.mode = "real";
  const box = { current: createPaperState() };
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 10_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /모의투자|KIS_MODE=demo/);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("vts-real-block");
});

test("emergency flatten can sell without a worker lock", async () => {
  process.env.TRADING_MODE = "live_test";
  resetWorkerLockForTest();
  const state = createPaperState();
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 70_000, ruleId: "cash" }];
  state.allocations = state.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: row.balance - 70_000 } : row,
  );
  const box = { current: state };
  const client = new FakeKis();
  await RiskManager.emergencyFlatten(box, { kis: client });
  assert.ok(client.orders.some((row) => row.side === "sell"));
  assert.equal(box.current.settings.autoTrading, false);
});

test("same-second manual intent ids collapse double submits", () => {
  const a = manualIntentId({ ruleId: "cash", ticker: "005930", side: "buy", qty: 1, atMs: 1_000 });
  const b = manualIntentId({ ruleId: "cash", ticker: "005930", side: "buy", qty: 1, atMs: 1_400 });
  const c = manualIntentId({ ruleId: "cash", ticker: "005930", side: "buy", qty: 1, atMs: 2_000 });
  assert.equal(a, b);
  assert.equal(a, makeSignalId(["sig", "manual", "cash", "005930", "buy", 1, 1]));
  assert.notEqual(a, c);
});

test("LIVE_TEST env values cannot exceed default caps", () => {
  const caps = liveTestCaps({
    LIVE_TEST_MAX_ORDER_KRW: "9999999",
    LIVE_TEST_MAX_DAILY_ORDER_AMOUNT: "9999999",
    LIVE_TEST_MAX_DAILY_ORDER_COUNT: "99",
  });
  assert.equal(caps.maxOrderKrw, 10_000);
  assert.equal(caps.maxDailyBuyKrw, 30_000);
  assert.equal(caps.maxDailyOrders, 3);
});
