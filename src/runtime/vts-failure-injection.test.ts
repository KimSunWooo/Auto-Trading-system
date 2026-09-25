import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createPaperState, tickState } from "@/lib/engine";
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
import { bookReportedFill, recordPending } from "@/src/accounts/fills";
import { tradingBlocked } from "@/src/risk/circuit";
import { RiskManager } from "@/src/risk/RiskManager";
import { recoverExternalOrders } from "@/src/runtime/recovery";
import { IndeterminateOrderError } from "@/src/risk/errors";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
  releaseWorkerLock,
} from "@/src/runtime/worker-lock";
import { HARD_LIMITS } from "@/src/risk/limits";
import { nowMs } from "@/src/clock";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => {
  setNowMs(null);
  setSharedKisClientForTest(null);
  resetWorkerLockForTest();
});
afterEach(() => {
  delete process.env.TRADING_MODE;
  delete process.env.BROKER;
  delete process.env.FAKE_BROKER_MODE;
  delete process.env.MOCK_BROKER_MODE;
  resetWorkerLockForTest();
  setSharedKisClientForTest(null);
});

function fakePrice(ticker: string, price = 100): KisPrice {
  return {
    ticker,
    name: ticker,
    price,
    open: price,
    high: price,
    low: price,
    prevClose: price,
    volume: 1_000,
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
  failQuote = false;
  failBalance = false;
  failCcld = false;
  failOpen = false;
  failOrder: Error | null = null;
  failCancel: Error | null = null;
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };

  async inquirePrice(ticker: string): Promise<KisPrice> {
    if (this.failQuote) throw new Error("quote down");
    return fakePrice(ticker);
  }
  async inquireDailyCloses(): Promise<number[]> {
    if (this.failQuote) throw new Error("quote down");
    return Array.from({ length: 30 }, () => 100);
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
    return { orderNo, krxOrgNo: "06010" };
  }
  async cancelOrder(order: KisCancelOrder): Promise<void> {
    if (this.failCancel) throw this.failCancel;
    this.cancels.push(order);
    const row = this.fills.find((fill) => fill.orderNo === order.orderNo);
    if (row) row.unfilledQty = 0;
  }
}

test("SIMULATED partial fill 100/40 then 60 without double-count", () => {
  const state = createPaperState();
  const started = recordPending(state, {
    source: "rule",
    ruleId: "cash",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 100,
    price: 100,
    intentId: "sig:partial:100",
  });
  let next = started.state;
  const parent = started.order;
  next = {
    ...next,
    orders: next.orders.map((row) =>
      row.id === parent.id ? { ...row, brokerOrderNo: "ODNO-P", orderedQty: 100, filledQty: 0 } : row,
    ),
  };
  const first = bookReportedFill(next, parent.id, { filledQty: 40, avgPrice: 100, brokerOrderNo: "ODNO-P" });
  next = first.state;
  assert.equal(first.parent.status, "pending");
  assert.equal(first.parent.filledQty, 40);
  assert.equal((first.parent.orderedQty ?? 100) - (first.parent.filledQty ?? 0), 60);
  const posAfter40 = next.positions.find((row) => row.code === "005930")?.qty ?? 0;
  assert.equal(posAfter40, 40);

  const dup = bookReportedFill(next, parent.id, { filledQty: 40, avgPrice: 100, brokerOrderNo: "ODNO-P" });
  next = dup.state;
  assert.equal(dup.parent.filledQty, 40);
  assert.equal(next.positions.find((row) => row.code === "005930")?.qty, 40);

  const rest = bookReportedFill(next, parent.id, { filledQty: 100, avgPrice: 100, brokerOrderNo: "ODNO-P" });
  next = rest.state;
  assert.equal(rest.parent.status, "filled");
  assert.equal(rest.parent.filledQty, 100);
  assert.equal(next.positions.find((row) => row.code === "005930")?.qty, 100);
  assert.equal(next.orders.filter((row) => row.parentOrderId === parent.id).length, 2);
});

test("SIMULATED timeout stays UNKNOWN with zero broker retries", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.failOrder = new IndeterminateOrderError("주문 응답 시간 초과. 체결 여부를 확인해야 합니다.");
  const broker = new KisBroker(box, client, "cash").withIntent({
    intentId: "sig:timeout:once",
    signalId: "sig:timeout:once",
  });
  const first = await broker.buyMarket("005930", 10_000);
  assert.equal(first.status, "unknown");
  assert.equal(client.orders.length, 0);
  client.failOrder = null;
  const second = await broker.buyMarket("005930", 10_000);
  assert.equal(second.status, "unknown");
  assert.equal(client.orders.length, 0);
  assert.ok(tradingBlocked(box.current));
});

test("SIMULATED timeout recovery links ODNO without a second orderCash", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.failOrder = new IndeterminateOrderError("timeout");
  const broker = new KisBroker(box, client, "cash").withIntent({
    intentId: "sig:to-recover",
    signalId: "sig:to-recover",
  });
  await broker.buyMarket("005930", 10_000);
  client.failOrder = null;
  client.open = [
    {
      orderNo: "0000000777",
      ticker: "005930",
      side: "buy",
      qty: 100,
      filledQty: 0,
      unfilledQty: 100,
      avgPrice: 100,
    },
  ];
  const recovered = await recoverExternalOrders(box, client);
  assert.equal(recovered.ok, true);
  const local = box.current.orders.find((row) => row.intentId === "sig:to-recover");
  assert.ok(local?.brokerOrderNo && /777/.test(local.brokerOrderNo));
  const again = await broker.buyMarket("005930", 10_000);
  assert.equal(client.orders.length, 0);
  assert.equal(again.orderId, local?.id);
});

test("SIMULATED duplicate signal and intent call orderCash once", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const broker = new KisBroker(box, client, "cash").withIntent({
    intentId: "sig:dup:1",
    signalId: "sig:dup:1",
  });
  for (let i = 0; i < 5; i += 1) {
    await broker.buyMarket("005930", 10_000);
  }
  assert.equal(client.orders.length, 1);
  assert.equal(box.current.orders.filter((row) => !row.parentOrderId).length, 1);
  assert.equal(box.current.intents?.filter((row) => row.intentId === "sig:dup:1").length, 1);
});

test("SIMULATED crash window: KIS has ODNO, local ghost links, no duplicate", async () => {
  const box = { current: createPaperState() };
  const started = recordPending(box.current, {
    source: "rule",
    ruleId: "cash",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 2,
    price: 100,
    intentId: "sig:crash",
  });
  box.current = started.state;
  const client = new FakeKis();
  client.open = [
    {
      orderNo: "0000000888",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 100,
    },
  ];
  await recoverExternalOrders(box, client);
  const linked = box.current.orders.find((row) => row.intentId === "sig:crash");
  assert.ok(linked?.brokerOrderNo && /888/.test(linked.brokerOrderNo));
  const fill = await new KisBroker(box, client, "cash")
    .withIntent({ intentId: "sig:crash", signalId: "sig:crash" })
    .buyMarket("005930", 10_000);
  assert.equal(client.orders.length, 0);
  assert.equal(fill.orderId, linked?.id);
});

function simLockPath(name: string): string {
  return path.join(tmpdir(), `vts-${name}-${process.pid}.lock`);
}

test("SIMULATED quote failure blocks LIVE_TEST orders", async () => {
  process.env.TRADING_MODE = "live_test";
  const filePath = simLockPath("quote");
  tryAcquireWorkerLock("vts-quote", { filePath });
  const client = new FakeKis();
  client.failQuote = true;
  const box = { current: createPaperState() };
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 10_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("vts-quote");
});

test("SIMULATED quote throttling does not place a new order", async () => {
  process.env.TRADING_MODE = "live_test";
  const filePath = simLockPath("throttle-q");
  tryAcquireWorkerLock("vts-throttle-q", { filePath });
  const client = new FakeKis();
  client.failQuote = true;
  const box = { current: createPaperState() };
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 10_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("vts-throttle-q");
});

test("SIMULATED balance/open/execution failures block new strategy orders", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  const filePath = simLockPath("query");
  tryAcquireWorkerLock("vts-query", { filePath });
  for (const kind of ["balance", "position", "open", "ccld"] as const) {
    const client = new FakeKis();
    if (kind === "balance" || kind === "position") client.failBalance = true;
    if (kind === "open") client.failOpen = true;
    if (kind === "ccld") client.failCcld = true;
    setSharedKisClientForTest(client);
    const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
    assert.ok(tradingBlocked(next), kind);
    const fill = await new KisBroker({ current: next }, client, "cash").buyMarket("005930", 10_000);
    assert.equal(fill.ok, false);
    assert.equal(client.orders.length, 0);
  }
  releaseWorkerLock("vts-query");
});

test("SIMULATED recon mismatch blocks new orders", async () => {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  const filePath = simLockPath("recon");
  tryAcquireWorkerLock("vts-recon", { filePath });
  const client = new FakeKis();
  client.balance = { cash: 1, d2Cash: 1, holdings: [] };
  setSharedKisClientForTest(client);
  const next = await tickState(createPaperState(), new Date(SEOUL_REGULAR_SESSION_MS));
  assert.ok(tradingBlocked(next));
  const fill = await new KisBroker({ current: next }, client, "cash").buyMarket("005930", 10_000);
  assert.equal(fill.ok, false);
  assert.equal(client.orders.length, 0);
  releaseWorkerLock("vts-recon");
});

test("SIMULATED order throttling does not blind-retry", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.failOrder = new IndeterminateOrderError("EGW00201 rate limit");
  const broker = new KisBroker(box, client, "cash").withIntent({
    intentId: "sig:throttle",
    signalId: "sig:throttle",
  });
  await broker.buyMarket("005930", 10_000);
  client.failOrder = null;
  await broker.buyMarket("005930", 10_000);
  assert.equal(client.orders.length, 0);
  assert.equal(box.current.orders.filter((row) => row.status === "unknown").length, 1);
});

test("SIMULATED cancel timeout does not mark cancelled", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  await new KisBroker(box, client, "cash").buyMarket("005930", 10_000);
  const parent = box.current.orders.find((row) => row.status === "pending")!;
  parent.createdAt = new Date(nowMs() - HARD_LIMITS.cancelUnfilledAfterMs - 1_000).toISOString();
  parent.brokerOrderNo = "0000000123";
  client.fills = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 100,
      filledQty: 0,
      unfilledQty: 100,
      avgPrice: 0,
    },
  ];
  const err = new Error("cancel timeout");
  err.name = "TimeoutError";
  client.failCancel = err;
  await settleOpenOrders(box, client);
  const live = box.current.orders.find((row) => row.id === parent.id)!;
  assert.equal(live.status, "unknown");
  assert.notEqual(live.status, "cancelled");
});

test("SIMULATED emergency stop blocks buys and does not flatten", async () => {
  const box = { current: createPaperState() };
  box.current.positions = [
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 100, ruleId: "cash" },
  ];
  await RiskManager.emergencyStop(box, { kis: null });
  assert.equal(box.current.settings.autoTrading, false);
  assert.equal(box.current.safety?.kind, "emergency_stop");
  assert.equal(box.current.killReport?.flattened, 0);
  const buy = await new KisBroker(box, new FakeKis(), "cash").buyMarket("005930", 10_000);
  assert.equal(buy.ok, false);
  assert.equal(box.current.positions[0]?.qty, 1);
});

test("SIMULATED emergency flatten without KisClient fails closed", async () => {
  assert.notEqual(process.env.RUN_KIS_VTS_FLATTEN_TEST, "true");
  const box = { current: createPaperState() };
  box.current.positions = [
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 100, ruleId: "cash" },
  ];
  await assert.rejects(
    () => RiskManager.emergencyFlatten(box, { kis: null }),
    (err: unknown) => err instanceof Error && /KIS_PAPER_RUNTIME_NOT_READY|not ready/.test(err.message),
  );
  assert.equal(box.current.positions.length, 1);
});
