import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { RiskManager } from "./RiskManager";
import { seoulDay } from "./limits";
import { tradingBlocked } from "./circuit";
import type { KisApi, KisAccountBalance, KisCancelOrder, KisCashOrder, KisDayOrder, KisPrice } from "@/src/brokers/kis-client";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

test("RiskManager blocks a buy that would exceed 20% ticker weight", () => {
  const state = createPaperState();
  const reason = RiskManager.checkBuy(state, {
    side: "buy",
    ticker: "005930",
    qty: 40,
    price: 70_000,
  });
  assert.match(reason ?? "", /20%/);
});

test("RiskManager allows a small buy under the product weight cap", () => {
  const state = createPaperState();
  const reason = RiskManager.checkBuy(state, {
    side: "buy",
    ticker: "005930",
    qty: 1,
    price: 70_000,
  });
  assert.equal(reason, null);
});

test("daily loss of 3% opens a daily-loss circuit", () => {
  const state = createPaperState();
  state.dayStart = { date: seoulDay(), equity: 10_000_000 };
  state.cash = 9_600_000;
  const halted = RiskManager.checkDailyLoss(state);
  assert.equal(halted.circuit.halted, true);
  assert.equal(halted.circuit.kind, "daily-loss");
  assert.match(tradingBlocked(halted) ?? "", /일일 최대 손실/);
});

test("stop-loss triggers at -5% vs average price", () => {
  assert.equal(RiskManager.shouldStopLoss(10_000, 9_500, 0.05), true);
  assert.equal(RiskManager.shouldStopLoss(10_000, 9_600, 0.05), false);
});

test("stop-loss sells with a -3% limit band in slices, not market", async () => {
  const state = createPaperState();
  const quote = state.quotes["005930"]!;
  quote.price = 70_000;
  quote.prevClose = 70_000;
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 10, avgPrice: 80_000, ruleId: "cash" },
  ];
  state.allocations = state.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: row.balance - 800_000 } : row,
  );
  state.cash = state.allocations.reduce((sum, row) => sum + row.balance, 0);
  const box = { current: state };
  await new RiskManager(box).enforceStops();
  const sells = box.current.orders.filter((row) => row.side === "sell");
  assert.equal(sells.length, 2);
  assert.ok(sells.every((row) => row.ordDvsn === "limit"));
  assert.deepEqual(
    sells.map((row) => row.qty).sort((a, b) => b - a),
    [7, 3],
  );
  assert.equal(box.current.positions.length, 0);
});

test("kill switch disables buckets and auto trading", () => {
  const state = createPaperState();
  state.orders = [
    {
      id: "p1",
      createdAt: new Date().toISOString(),
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70_000,
      amount: 70_000,
      commission: 0,
      tax: 0,
      net: 70_000,
      status: "pending",
    },
  ];
  const stopped = RiskManager.stopAllTrading(state);
  assert.equal(stopped.settings.autoTrading, false);
  assert.equal(stopped.circuit.kind, "kill");
  assert.ok(stopped.allocations.every((row) => !row.enabled));
  assert.equal(stopped.orders[0]?.status, "cancelled");
});

test("executeKillSwitch band-limit sells mock positions then halts", async () => {
  const state = createPaperState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, ruleId: "cash" },
  ];
  state.allocations = state.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: row.balance - 140_000 } : row,
  );
  state.cash = state.allocations.reduce((sum, row) => sum + row.balance, 0);
  const box = { current: state };
  const after = await RiskManager.executeKillSwitch(box, { kis: null });
  assert.equal(after.settings.autoTrading, false);
  assert.equal(after.settings.liquidating, false);
  assert.equal(after.circuit.kind, "kill");
  assert.equal(after.positions.length, 0);
  assert.equal(after.killReport?.flattened, 1);
  assert.equal(after.killReport?.overwritten, false);
  assert.ok((after.allocations.find((row) => row.ruleId === "cash")?.balance ?? 0) > 6_800_000);
  assert.ok(after.orders.filter((row) => row.side === "sell").every((row) => row.ordDvsn === "limit"));
});

class KillKis implements KisApi {
  readonly mode = "paper" as const;
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  cancels: KisCancelOrder[] = [];
  orders: KisCashOrder[] = [];
  fills: KisDayOrder[] = [];
  balance: KisAccountBalance = { cash: 8_500_000, d2Cash: 8_500_000, holdings: [] };
  failCancel: string | null = null;

  async inquirePrice(ticker: string): Promise<KisPrice> {
    return {
      ticker,
      name: "삼성전자",
      price: 70_000,
      open: 70_000,
      high: 71_000,
      low: 69_000,
      prevClose: 69_500,
      volume: 1,
    };
  }
  async inquireDailyCloses(): Promise<number[]> {
    return [];
  }
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    return this.fills.map((row) => ({ ...row }));
  }
  async inquireOpenOrders(): Promise<KisDayOrder[]> {
    return this.fills.filter((row) => row.unfilledQty > 0).map((row) => ({ ...row }));
  }
  async inquireBalance(): Promise<KisAccountBalance> {
    return {
      cash: this.balance.cash,
      d2Cash: this.balance.d2Cash,
      holdings: this.balance.holdings.map((row) => ({ ...row })),
    };
  }
  async orderCash(order: KisCashOrder) {
    this.orders.push(order);
    return { orderNo: "0000000123", krxOrgNo: "06010" };
  }
  async cancelOrder(order: KisCancelOrder) {
    if (this.failCancel) {
      const err = new Error(this.failCancel);
      err.name = "TimeoutError";
      this.failCancel = null;
      throw err;
    }
    this.cancels.push(order);
  }
}

test("executeKillSwitch cancels KIS working orders immediately and overwrites the book", async () => {
  const state = createPaperState();
  state.orders = [
    {
      id: "k1",
      createdAt: new Date().toISOString(),
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70_000,
      amount: 70_000,
      commission: 0,
      tax: 0,
      net: 70_000,
      status: "pending",
      brokerOrderNo: "0000000123",
      krxOrgNo: "06010",
      ordDvsn: "market",
      orderedQty: 1,
      filledQty: 0,
    },
  ];
  const client = new KillKis();
  const after = await RiskManager.executeKillSwitch({ current: state }, { kis: client });
  assert.equal(client.cancels.length, 1);
  assert.equal(after.orders.find((row) => row.id === "k1")?.status, "cancelled");
  assert.equal(after.killReport?.overwritten, true);
  assert.equal(after.cash, 8_500_000);
  assert.equal(after.circuit.kind, "kill");
});

test("executeKillSwitch skips flatten when a cancel stays unknown", async () => {
  const state = createPaperState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, ruleId: "cash" },
  ];
  state.orders = [
    {
      id: "u1",
      createdAt: new Date().toISOString(),
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70_000,
      amount: 70_000,
      commission: 0,
      tax: 0,
      net: 70_000,
      status: "pending",
      brokerOrderNo: "0000000456",
      krxOrgNo: "06010",
      orderedQty: 1,
      filledQty: 0,
    },
  ];
  const client = new KillKis();
  client.failCancel = "cancel timeout";
  const after = await RiskManager.executeKillSwitch({ current: state }, { kis: client });
  assert.equal(after.orders.find((row) => row.id === "u1")?.status, "unknown");
  assert.equal(after.positions.length, 1);
  assert.equal(after.killReport?.overwritten, false);
  assert.equal(after.killReport?.flattened, 0);
  assert.match(after.killReport?.notes.join(" ") ?? "", /미확인/);
});
