import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { KisBroker } from "./KisBroker";
import { MockBroker } from "./MockBroker";
import type { KisApi, KisAccountBalance, KisCancelOrder, KisCashOrder, KisDayOrder, KisPrice } from "./kis-client";
import { padOdno, sameOdno } from "./kis-client";
import { createPaperState } from "@/lib/engine";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { HARD_LIMITS } from "@/src/risk/limits";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs, nowMs, withNow } from "@/src/clock";
import { bandLimitPrice } from "@/src/accounts/execution-policy";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

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
  readonly mode = "demo" as const;
  configured: boolean;
  liveEnabled: boolean;
  issues: string[];
  orders: KisCashOrder[] = [];
  fills: KisDayOrder[] = [];
  cancels: KisCancelOrder[] = [];
  failNext: string | null = null;
  failCancel: string | null = null;
  failOpen = false;
  failCcld = false;
  keepOpenAfterCancel = false;
  autoFill = false;
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };

  constructor(opts: { configured?: boolean; liveEnabled?: boolean; issues?: string[] } = {}) {
    this.configured = opts.configured ?? true;
    this.liveEnabled = opts.liveEnabled ?? true;
    this.issues = opts.issues ?? [];
  }

  async inquirePrice(ticker: string): Promise<KisPrice> {
    return fakePrice(ticker);
  }

  async inquireDailyCloses(): Promise<number[]> {
    return Array.from({ length: 30 }, () => 70_000);
  }

  async inquireDailyCcld() {
    if (this.failCcld) throw new Error("execution down");
    return this.fills.map((row) => ({ ...row }));
  }

  async inquireOpenOrders() {
    if (this.failOpen) throw new Error("open orders down");
    return this.fills.filter((row) => row.unfilledQty > 0).map((row) => ({ ...row }));
  }

  async inquireBalance(): Promise<KisAccountBalance> {
    return {
      cash: this.balance.cash,
      d2Cash: this.balance.d2Cash,
      holdings: this.balance.holdings.map((row) => ({ ...row })),
    };
  }

  async orderCash(order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    this.orders.push(order);
    const orderNo = "0000000123";
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
    if (this.failCancel) {
      const msg = this.failCancel;
      this.failCancel = null;
      const err = new Error(msg);
      if (/timeout/i.test(msg)) err.name = "TimeoutError";
      throw err;
    }
    this.cancels.push(order);
    if (this.keepOpenAfterCancel) return;
    const row = this.fills.find((fill) => sameOdno(fill.orderNo, order.orderNo));
    if (row) row.unfilledQty = 0;
  }
}

test("sameOdno matches padded KIS order numbers", () => {
  assert.equal(sameOdno("0000000123", "123"), true);
  assert.equal(padOdno("123"), "0000000123");
  assert.equal(sameOdno("99", "100"), false);
});

test("KisBroker without credentials refuses orders and does not hit KIS", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis({
    configured: false,
    liveEnabled: false,
    issues: ["KIS_APP_KEY 가 없습니다."],
  });
  const fill = await new KisBroker(box, client).buyMarket("005930", 100_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /KIS_APP_KEY/);
  assert.equal(client.orders.length, 0);
});

test("KisBroker treats ODNO as working, not a full fill", async () => {
  const box = { current: createPaperState() };
  const before = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.equal(fill.status, "pending");
  assert.equal(fill.qty, 2);
  assert.equal(client.orders.length, 1);
  assert.equal(client.orders[0]?.ordDvsn, "limit");
  assert.equal(client.orders[0]?.price, bandLimitPrice("buy", 70_000));
  const after = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  assert.equal(after, before);
  const parent = box.current.orders.find((o) => o.status === "pending");
  assert.ok(parent);
  assert.equal(parent?.brokerOrderNo, "0000000123");
  assert.equal(parent?.krxOrgNo, "06010");
  assert.equal(parent?.filledQty, 0);
  assert.equal(parent?.orderedQty, 2);
});

test("KisBroker books a fill only after daily ccld reports qty", async () => {
  const box = { current: createPaperState() };
  const before = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  const client = new FakeKis();
  client.autoFill = true;
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, true);
  assert.equal(fill.status, "filled");
  const after = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  assert.ok(after < before);
  const children = box.current.orders.filter((o) => o.parentOrderId);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.qty, 2);
  assert.equal(children[0]?.status, "filled");
});

test("KisBroker checks the bucket before calling KIS", async () => {
  const box = { current: createPaperState() };
  const level1 = box.current.allocations.find((a) => a.ruleId === "cash")!;
  level1.balance = 1_000;
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /잔액/);
  assert.equal(client.orders.length, 0);
});

test("KisBroker blocks live orders when confirm is missing", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis({ liveEnabled: false });
  const fill = await new KisBroker(box, client).buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /잠겨/);
  assert.equal(client.orders.length, 0);
});

test("timeout after orderCash marks unknown and blocks the next buy", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.orderCash = async () => {
    const err = new Error("timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const first = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(first.ok, false);
  assert.equal(first.status, "unknown");
  assert.equal(box.current.circuit.halted, true);
  assert.equal(box.current.orders[0]?.status, "unknown");

  const second = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(second.ok, false);
  assert.match(second.reason ?? "", /확인하지|서킷|미확인/);
});

test("hard limit blocks a ticket before it reaches KIS", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 3_000_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /한도/);
  assert.equal(client.orders.length, 0);
});

test("pending working order blocks another buy of the same ticker", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const first = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(first.status, "pending");
  const second = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(second.ok, false);
  assert.match(second.reason ?? "", /미체결/);
  assert.equal(client.orders.length, 1);
});

test("settleOpenOrders books only the reported partial fill", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  const parent = box.current.orders.find((o) => o.status === "pending")!;
  const before = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  client.fills = [
    {
      orderNo: "123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 1,
      unfilledQty: 1,
      avgPrice: 70_000,
    },
  ];
  await settleOpenOrders(box, client);
  const after = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  assert.ok(after < before);
  const live = box.current.orders.find((o) => o.id === parent.id)!;
  assert.equal(live.status, "pending");
  assert.equal(live.filledQty, 1);
  const child = box.current.orders.find((o) => o.parentOrderId === parent.id);
  assert.equal(child?.qty, 1);
  assert.equal(child?.status, "filled");
  assert.equal(client.cancels.length, 0);
});

test("settleOpenOrders cancels remaining qty after the timeout", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  const parent = box.current.orders.find((o) => o.status === "pending")!;
  parent.createdAt = new Date(nowMs() - HARD_LIMITS.cancelUnfilledAfterMs - 1_000).toISOString();
  client.fills = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 1,
      unfilledQty: 1,
      avgPrice: 70_000,
    },
  ];
  await settleOpenOrders(box, client);
  assert.equal(client.cancels.length, 1);
  assert.equal(client.cancels[0]?.ordDvsn, "limit");
  const live = box.current.orders.find((o) => o.id === parent.id)!;
  assert.equal(live.status, "filled");
  assert.equal(live.filledQty, 1);
  assert.match(live.reason ?? "", /잔량 취소/);
  const child = box.current.orders.find((o) => o.parentOrderId === parent.id);
  assert.equal(child?.qty, 1);
});

test("settleOpenOrders cancels a still-unfilled ticket with no fills", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  const parent = box.current.orders.find((o) => o.status === "pending")!;
  parent.createdAt = new Date(nowMs() - HARD_LIMITS.cancelUnfilledAfterMs - 1_000).toISOString();
  client.fills = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 0,
    },
  ];
  const before = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  await settleOpenOrders(box, client);
  assert.equal(client.cancels.length, 1);
  const live = box.current.orders.find((o) => o.id === parent.id)!;
  assert.equal(live.status, "cancelled");
  assert.equal(live.filledQty, 0);
  const after = box.current.allocations.find((a) => a.ruleId === "cash")!.balance;
  assert.equal(after, before);
});

test("settleOpenOrders does not mark cancelled until KIS nccs drops the ODNO", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  client.keepOpenAfterCancel = true;
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  const parent = box.current.orders.find((o) => o.status === "pending")!;
  parent.createdAt = new Date(nowMs() - HARD_LIMITS.cancelUnfilledAfterMs - 1_000).toISOString();
  client.fills = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 0,
    },
  ];
  await settleOpenOrders(box, client);
  assert.equal(client.cancels.length, 1);
  const live = box.current.orders.find((o) => o.id === parent.id)!;
  assert.equal(live.status, "pending");
});

test("settleOpenOrders leaves UNKNOWN when post-cancel inquiry fails", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  const parent = box.current.orders.find((o) => o.status === "pending")!;
  parent.createdAt = new Date(nowMs() - HARD_LIMITS.cancelUnfilledAfterMs - 1_000).toISOString();
  client.fills = [
    {
      orderNo: "0000000123",
      ticker: "005930",
      side: "buy",
      qty: 2,
      filledQty: 0,
      unfilledQty: 2,
      avgPrice: 0,
    },
  ];
  client.failOpen = true;
  await settleOpenOrders(box, client);
  const live = box.current.orders.find((o) => o.id === parent.id)!;
  assert.equal(live.status, "unknown");
  assert.match(live.reason ?? "", /미체결 조회/);
});

test("MockBroker getCurrentPrice reads the paper book", async () => {
  const box = { current: createPaperState() };
  const broker = new MockBroker(box, "cash");
  const price = await broker.getCurrentPrice("005930");
  assert.ok(price > 0);
});

test("KisBroker converts any market buy to a ±3% limit band", async () => {
  const box = { current: createPaperState() };
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
  assert.equal(fill.status, "pending");
  assert.equal(fill.qty, 2);
  assert.equal(client.orders[0]?.ordDvsn, "limit");
  assert.equal(client.orders[0]?.price, bandLimitPrice("buy", 70_000));
  assert.equal(box.current.orders[0]?.ordDvsn, "limit");
});

test("KisBroker rejects a new order during closing auction", async () => {
  await withNow(Date.UTC(2026, 8, 15, 6, 20, 0), async () => {
    const box = { current: createPaperState() };
    const client = new FakeKis();
    const fill = await new KisBroker(box, client, "cash").buyMarket("005930", 140_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /09:00~15:20|동시호가/);
    assert.equal(client.orders.length, 0);
  });
});

test("KisBroker sellLimit sends a limit cash order", async () => {
  const box = { current: createPaperState() };
  box.current.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, ruleId: "cash" },
  ];
  const client = new FakeKis();
  const limit = bandLimitPrice("sell", 70_000);
  const fill = await new KisBroker(box, client, "cash").sellLimit("005930", limit, 2);
  assert.equal(fill.status, "pending");
  assert.equal(client.orders[0]?.ordDvsn, "limit");
  assert.equal(client.orders[0]?.price, limit);
  assert.equal(client.orders[0]?.qty, 2);
});
