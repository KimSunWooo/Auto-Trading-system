import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFill,
  conditionMatches,
  createPaperState,
  evaluateConditions,
  evaluateDca,
} from "./engine";
import { floorToTick, roundToTick, tickSize } from "./tick-size";
import type { AutoCondition, DcaPlan } from "./types";

test("tick size follows KRX bands", () => {
  assert.equal(tickSize(1500), 1);
  assert.equal(tickSize(3000), 5);
  assert.equal(tickSize(10000), 10);
  assert.equal(tickSize(30000), 50);
  assert.equal(tickSize(74800), 100);
  assert.equal(tickSize(382000), 500);
  assert.equal(roundToTick(74830), 74800);
  assert.equal(floorToTick(67900), 67900);
  assert.equal(floorToTick(67940), 67900);
});

test("buy fill updates cash and average price", () => {
  const state = createPaperState();
  const samsung = state.quotes["005930"];
  const first = applyFill(state, {
    source: "manual",
    code: samsung.code,
    name: samsung.name,
    side: "buy",
    qty: 10,
    price: 70000,
  });
  assert.equal(first.order.status, "filled");
  assert.equal(first.state.positions[0]?.qty, 10);
  const second = applyFill(first.state, {
    source: "manual",
    code: samsung.code,
    name: samsung.name,
    side: "buy",
    qty: 10,
    price: 80000,
  });
  assert.equal(second.state.positions[0]?.avgPrice, 75000);
});

test("sell rejects when quantity is missing", () => {
  const state = createPaperState();
  const samsung = state.quotes["005930"];
  const result = applyFill(state, {
    source: "manual",
    code: samsung.code,
    name: samsung.name,
    side: "sell",
    qty: 1,
    price: samsung.price,
  });
  assert.equal(result.order.status, "rejected");
});

test("price-below condition fires a market buy", async () => {
  const state = createPaperState();
  const quote = state.quotes["005930"];
  const cond: AutoCondition = {
    id: "c1",
    code: quote.code,
    name: quote.name,
    side: "buy",
    watchBasis: "last",
    operator: "lte",
    triggerPrice: quote.price + 1000,
    volumeEnabled: false,
    volumeOp: "gte",
    volume: 0,
    qty: 5,
    orderPriceType: "market",
    limitPrice: null,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    watching: true,
    status: "watching",
    createdAt: new Date().toISOString(),
  };
  assert.equal(conditionMatches(cond, quote), true);
  const next = await evaluateConditions({ ...state, conditions: [cond] }, new Date().toISOString());
  assert.equal(next.conditions[0]?.status, "filled");
  assert.equal(next.orders[0]?.qty, 5);
  assert.equal(next.orders[0]?.source, "condition");
});

test("DCA buys whole shares and schedules the next run", async () => {
  const state = createPaperState();
  const quote = state.quotes["035720"];
  const plan: DcaPlan = {
    id: "d1",
    code: quote.code,
    name: quote.name,
    amountKrw: quote.price * 2 + 100,
    intervalSec: 60,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
  const next = await evaluateDca({ ...state, dcaPlans: [plan] }, new Date().toISOString());
  assert.equal(next.dcaPlans[0]?.runCount, 1);
  assert.equal(next.orders[0]?.source, "dca");
  assert.ok((next.dcaPlans[0]?.nextRunAt ?? "") > plan.nextRunAt);
});
