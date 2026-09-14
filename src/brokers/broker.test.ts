import assert from "node:assert/strict";
import test from "node:test";
import { KisBroker } from "./KisBroker";
import { MockBroker } from "./MockBroker";
import type { KisApi, KisCashOrder, KisPrice } from "./kis-client";
import { createInitialState } from "@/lib/engine";

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
  failNext: string | null = null;

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

  async orderCash(order: KisCashOrder): Promise<{ orderNo: string }> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    this.orders.push(order);
    return { orderNo: "0000000123" };
  }
}

test("KisBroker without credentials refuses orders and does not hit KIS", async () => {
  const box = { current: createInitialState() };
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

test("KisBroker sends a cash order then books the fill once", async () => {
  const box = { current: createInitialState() };
  const before = box.current.allocations.find((a) => a.strategy === "Level1_Stable")!.balance;
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "Level1_Stable").buyMarket("005930", 140_000);
  assert.equal(fill.ok, true);
  assert.equal(fill.qty, 2);
  assert.equal(fill.orderId, "0000000123");
  assert.equal(client.orders.length, 1);
  assert.equal(client.orders[0]?.ordDvsn, "market");
  const after = box.current.allocations.find((a) => a.strategy === "Level1_Stable")!.balance;
  assert.ok(after < before);
  assert.equal(box.current.orders.filter((o) => o.status === "filled").length, 1);
});

test("KisBroker checks the bucket before calling KIS", async () => {
  const box = { current: createInitialState() };
  const level1 = box.current.allocations.find((a) => a.strategy === "Level1_Stable")!;
  level1.balance = 1_000;
  const client = new FakeKis();
  const fill = await new KisBroker(box, client, "Level1_Stable").buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /잔액/);
  assert.equal(client.orders.length, 0);
});

test("KisBroker blocks live orders when confirm is missing", async () => {
  const box = { current: createInitialState() };
  const client = new FakeKis({ liveEnabled: false });
  const fill = await new KisBroker(box, client).buyMarket("005930", 140_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /KIS_LIVE_CONFIRM/);
  assert.equal(client.orders.length, 0);
});

test("MockBroker getCurrentPrice reads the paper book", async () => {
  const box = { current: createInitialState() };
  const broker = new MockBroker(box, "Level1_Stable");
  const price = await broker.getCurrentPrice("005930");
  assert.ok(price > 0);
});
