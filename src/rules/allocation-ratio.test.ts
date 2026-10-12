import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyBudgetSync,
  computeStrategyCashLimit,
  convertLegacyToRatio,
  planBuyAmountKrw,
  readOrderableCashSnapshot,
  strategyBudgetView,
  validateAllocationPctSum,
} from "@/src/rules/allocation-ratio";
import { blankRule, CASH_RULE_ID } from "@/src/rules/params";
import { createInitialState } from "@/lib/engine";

function stateWithOrderable(orderable: number | null, deposit = 1_000_000) {
  const state = createInitialState();
  state.totalDeposit = deposit;
  state.allocations = [
    { ruleId: CASH_RULE_ID, budget: deposit, balance: deposit, enabled: true },
  ];
  state.cash = deposit;
  state.kisBalance = {
    syncedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    cash: deposit,
    d2Cash: deposit,
    orderableCash: orderable ?? undefined,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: orderable == null ? "unknown" : "fresh",
    message: "test",
  };
  state.quotes["069500"] = {
    code: "069500",
    name: "KODEX",
    market: "KOSPI",
    price: 10_000,
    prevClose: 10_000,
    open: 10_000,
    high: 10_000,
    low: 10_000,
    volume: 0,
    bid: 10_000,
    ask: 10_000,
    history: [],
  };
  return state;
}

test("orderable 100만 → 60만 with 30% allocation computes 30만 → 18만", () => {
  const rule = blankRule({
    ticker: "069500",
    budgetMode: "orderable_ratio",
    allocationPct: 0.3,
    buyPct: 0.5,
    sliceKrw: 1_000_000,
    enabled: true,
  });
  const s1 = stateWithOrderable(1_000_000);
  s1.allocations.push({
    ruleId: rule.id,
    budget: 300_000,
    balance: 300_000,
    enabled: true,
  });
  const v1 = strategyBudgetView(s1, rule);
  assert.equal(v1.computedCashLimit, 300_000);

  const s2 = stateWithOrderable(600_000);
  s2.allocations.push({
    ruleId: rule.id,
    budget: 300_000,
    balance: 300_000,
    enabled: true,
  });
  const v2 = strategyBudgetView(s2, rule);
  assert.equal(v2.computedCashLimit, 180_000);
});

test("ratio sync does not invent cash or wipe positions", () => {
  const rule = blankRule({
    ticker: "069500",
    budgetMode: "orderable_ratio",
    allocationPct: 0.3,
    enabled: true,
  });
  const state = stateWithOrderable(1_000_000);
  state.positions = [
    { code: "069500", name: "KODEX", qty: 3, avgPrice: 11_000, ruleId: rule.id },
  ];
  state.allocations = [
    { ruleId: CASH_RULE_ID, budget: 700_000, balance: 700_000, enabled: true },
    { ruleId: rule.id, budget: 300_000, balance: 200_000, enabled: true },
  ];
  state.cash = 900_000;
  const cashBefore = state.cash;
  const posBefore = structuredClone(state.positions);
  const next = applyBudgetSync(state, [rule]);
  assert.equal(next.cash, cashBefore);
  assert.deepEqual(next.positions, posBefore);
  assert.equal(next.orders.length, state.orders.length);
});

test("allocation pct sum > 100% rejected", () => {
  const a = blankRule({
    ticker: "069500",
    enabled: true,
    budgetMode: "orderable_ratio",
    allocationPct: 0.6,
  });
  const b = blankRule({
    ticker: "069500",
    enabled: true,
    budgetMode: "orderable_ratio",
    allocationPct: 0.5,
  });
  assert.ok(validateAllocationPctSum([a, b]));
});

test("null/stale orderable never pretended as 0 for buys", () => {
  const rule = blankRule({
    ticker: "069500",
    budgetMode: "orderable_ratio",
    allocationPct: 0.3,
    enabled: true,
  });
  const missing = stateWithOrderable(null);
  missing.kisBalance!.orderableCash = undefined;
  const snap = readOrderableCashSnapshot(missing);
  assert.equal(snap.orderableCash, null);
  const view = strategyBudgetView(missing, rule);
  assert.equal(view.buyableCash, null);
  assert.ok(view.blockReason);
});

test("planBuyAmountKrw does not force 1 share", () => {
  const planned = planBuyAmountKrw({
    buyableCash: 5_000,
    buyPct: 1,
    sliceKrw: 100_000,
    minAmountKrw: 1_000,
    price: 10_000,
  });
  assert.equal(planned.qty, 0);
  assert.ok(planned.blockReason);
});

test("legacy convert rejects when ratio > 100%", () => {
  const bad = convertLegacyToRatio(2_000_000, 1_000_000);
  assert.ok("error" in bad);
  const ok = convertLegacyToRatio(300_000, 1_000_000);
  assert.ok("allocationPct" in ok);
  if ("allocationPct" in ok) {
    assert.equal(ok.computedCashLimit, 300_000);
  }
});

test("computeStrategyCashLimit pure function", () => {
  const rule = blankRule({
    ticker: "069500",
    budgetMode: "orderable_ratio",
    allocationPct: 0.3,
  });
  assert.equal(computeStrategyCashLimit(rule, 600_000), 180_000);
});
