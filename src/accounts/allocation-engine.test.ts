import assert from "node:assert/strict";
import { test } from "node:test";
import { AllocationEngine } from "@/src/accounts/index";
import { createInitialState } from "@/lib/engine";
import { CASH_RULE_ID } from "@/src/rules/params";

function baseState() {
  const state = createInitialState();
  state.totalDeposit = 100_000;
  state.allocations = [
    { ruleId: CASH_RULE_ID, budget: 50_000, balance: 50_000, enabled: true },
    { ruleId: "r1", budget: 50_000, balance: 50_000, enabled: true },
  ];
  state.cash = 100_000;
  state.positions = [
    { code: "069500", name: "KODEX", qty: 2, avgPrice: 25_000, ruleId: "r1" },
  ];
  state.orders = [];
  return state;
}

test("PATCH budget 50만 on 10만 cash does not inflate ledger cash", () => {
  const state = baseState();
  assert.throws(
    () => AllocationEngine.patch(state, "r1", { budget: 500_000 }),
    /현금 버킷 잔액이 부족/,
  );
  const after = AllocationEngine.patch(state, "r1", { budget: 60_000 });
  assert.equal(after.cash, 100_000);
  assert.equal(
    after.allocations.find((a) => a.ruleId === "r1")?.budget,
    60_000,
  );
  assert.equal(
    after.allocations.find((a) => a.ruleId === CASH_RULE_ID)?.balance,
    40_000,
  );
  assert.equal(after.positions.length, 1);
  assert.equal(after.positions[0]?.avgPrice, 25_000);
});

test("rebalance preserves positions and avgPrice", () => {
  const state = baseState();
  const next = AllocationEngine.rebalance(state, [
    { ruleId: CASH_RULE_ID, budget: 40_000, enabled: true },
    { ruleId: "r1", budget: 60_000, enabled: true },
  ]);
  assert.equal(next.positions.length, 1);
  assert.equal(next.positions[0]?.qty, 2);
  assert.equal(next.positions[0]?.avgPrice, 25_000);
  assert.equal(next.orders.length, 0);
});
