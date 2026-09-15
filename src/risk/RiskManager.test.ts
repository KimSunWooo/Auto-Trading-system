import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "@/lib/engine";
import { RiskManager } from "./RiskManager";
import { seoulDay } from "./limits";
import { tradingBlocked } from "./circuit";

test("RiskManager blocks a buy that would exceed 20% ticker weight", () => {
  const state = createInitialState();
  const reason = RiskManager.checkBuy(state, {
    side: "buy",
    ticker: "005930",
    qty: 40,
    price: 70_000,
  });
  assert.match(reason ?? "", /20%/);
});

test("RiskManager allows a small buy under the product weight cap", () => {
  const state = createInitialState();
  const reason = RiskManager.checkBuy(state, {
    side: "buy",
    ticker: "005930",
    qty: 1,
    price: 70_000,
  });
  assert.equal(reason, null);
});

test("daily loss of 3% opens a daily-loss circuit", () => {
  const state = createInitialState();
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

test("kill switch disables buckets and auto trading", () => {
  const state = createInitialState();
  state.orders = [
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
    },
  ];
  const stopped = RiskManager.stopAllTrading(state);
  assert.equal(stopped.settings.autoTrading, false);
  assert.equal(stopped.circuit.kind, "kill");
  assert.ok(stopped.allocations.every((row) => !row.enabled));
  assert.equal(stopped.orders[0]?.status, "cancelled");
});
