import assert from "node:assert/strict";
import test from "node:test";
import { applyKisSnapshot, diffLocalVsKis, syncKisBalance } from "./balance-sync";
import type { KisAccountBalance, KisApi, KisCashOrder, KisDayOrder, KisPrice } from "@/src/brokers/kis-client";
import { createInitialState } from "@/lib/engine";
import { HARD_LIMITS } from "@/src/risk/limits";

class FakeBalanceClient implements KisApi {
  readonly mode = "demo" as const;
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  calls = 0;
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };
  fail = false;

  async inquirePrice(ticker: string): Promise<KisPrice> {
    return {
      ticker,
      name: ticker,
      price: 1,
      open: 1,
      high: 1,
      low: 1,
      prevClose: 1,
      volume: 0,
    };
  }
  async inquireDailyCloses(): Promise<number[]> {
    return [];
  }
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    return [];
  }
  async inquireBalance(): Promise<KisAccountBalance> {
    this.calls += 1;
    if (this.fail) throw new Error("balance down");
    return {
      cash: this.balance.cash,
      d2Cash: this.balance.d2Cash,
      holdings: this.balance.holdings.map((row) => ({ ...row })),
    };
  }
  async orderCash(_order: KisCashOrder) {
    return { orderNo: "1", krxOrgNo: "1" };
  }
  async cancelOrder() {}
}

test("diffLocalVsKis matches seed cash and empty holdings", () => {
  const state = createInitialState();
  const diff = diffLocalVsKis(state, {
    cash: 10_000_000,
    d2Cash: 10_000_000,
    holdings: [],
  });
  assert.equal(diff.matched, true);
  assert.equal(diff.cashDelta, 0);
});

test("diffLocalVsKis flags cash drift without using the 0.015% fee rate", () => {
  const state = createInitialState();
  const diff = diffLocalVsKis(state, {
    cash: 9_999_977,
    d2Cash: 9_999_977,
    holdings: [],
  });
  assert.equal(diff.matched, false);
  assert.equal(diff.cashDelta, 23);
  assert.match(diff.reasons.join(" "), /예수금/);
  assert.ok(Math.abs(diff.cashDelta) > HARD_LIMITS.balanceCashToleranceKrw);
});

test("diffLocalVsKis sums strategy buckets per ticker", () => {
  const state = createInitialState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, strategy: "Level1_Stable" },
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 71_000, strategy: "Level10_Aggressive" },
  ];
  const ok = diffLocalVsKis(state, {
    cash: state.cash,
    d2Cash: state.cash,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 3, avgPrice: 70_000 }],
  });
  assert.equal(ok.matched, true);

  const bad = diffLocalVsKis(state, {
    cash: state.cash,
    d2Cash: state.cash,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000 }],
  });
  assert.equal(bad.matched, false);
  assert.match(bad.reasons.join(" "), /005930/);
});

test("applyKisSnapshot overwrites local cash and holdings from KIS", () => {
  const state = createInitialState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 4, avgPrice: 70_000, strategy: "Level1_Stable" },
  ];
  const next = applyKisSnapshot(state, {
    cash: 8_000_000,
    d2Cash: 8_000_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 72_000 }],
  });
  assert.equal(next.cash, 8_000_000);
  assert.equal(next.positions.length, 1);
  assert.equal(next.positions[0]?.qty, 1);
  assert.equal(next.positions[0]?.avgPrice, 72_000);
  assert.equal(next.kisBalance?.matched, true);
  assert.ok(next.allocations.every((row) => !row.enabled));
});

test("syncKisBalance halts when KIS cash diverges from local buckets", async () => {
  const box = { current: createInitialState() };
  const client = new FakeBalanceClient();
  client.balance.cash = 8_000_000;
  await syncKisBalance(box, client, Date.now(), { force: true });
  assert.equal(box.current.circuit.halted, true);
  assert.match(box.current.circuit.reason ?? "", /실잔고/);
  assert.equal(box.current.kisBalance?.matched, false);
  assert.equal(box.current.kisBalance?.cash, 8_000_000);
});

test("syncKisBalance does not halt while a working KIS order is open", async () => {
  const box = { current: createInitialState() };
  box.current.orders = [
    {
      id: "p1",
      createdAt: new Date().toISOString(),
      source: "strategy",
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
      orderedQty: 1,
      filledQty: 0,
    },
  ];
  const client = new FakeBalanceClient();
  client.balance.cash = 1;
  await syncKisBalance(box, client, Date.now(), { force: true });
  assert.equal(box.current.circuit.halted, false);
  assert.equal(box.current.kisBalance?.matched, false);
});

test("syncKisBalance skips a second call inside the interval", async () => {
  const box = { current: createInitialState() };
  const client = new FakeBalanceClient();
  const now = 1_000_000;
  await syncKisBalance(box, client, now, { force: true });
  assert.equal(client.calls, 1);
  await syncKisBalance(box, client, now + 1_000);
  assert.equal(client.calls, 1);
});

test("syncKisBalance halts on holding qty mismatch", async () => {
  const box = { current: createInitialState() };
  box.current.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, strategy: "Level1_Stable" },
  ];
  const client = new FakeBalanceClient();
  client.balance.holdings = [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 70_000 }];
  await syncKisBalance(box, client, Date.now(), { force: true });
  assert.equal(box.current.circuit.halted, true);
  assert.match(box.current.kisBalance?.message ?? "", /005930/);
});
