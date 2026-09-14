import assert from "node:assert/strict";
import test from "node:test";
import { checkHardLimits, HARD_LIMITS } from "./limits";
import { emptyCircuit, resetCircuit, tradingBlocked } from "./circuit";
import { createInitialState } from "@/lib/engine";

test("checkHardLimits rejects an oversized ticket", () => {
  const state = createInitialState();
  const reason = checkHardLimits(state, {
    side: "buy",
    ticker: "005930",
    qty: 50,
    price: 70_000,
  });
  assert.ok(reason);
  assert.match(reason ?? "", /한도/);
  assert.ok(50 * 70_000 > HARD_LIMITS.maxOrderKrw);
});

test("unknown orders keep the circuit closed to new tickets", () => {
  const state = createInitialState();
  state.orders.unshift({
    id: "u1",
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
    status: "unknown",
  });
  assert.match(tradingBlocked(state) ?? "", /미확인/);
  const reset = resetCircuit({ ...state, circuit: { halted: true, unknownCount: 1 } });
  assert.ok(reset.error);
});

test("resetCircuit clears halt when there is no unknown order", () => {
  const state = createInitialState();
  state.circuit = { halted: true, unknownCount: 1, reason: "test" };
  const reset = resetCircuit(state);
  assert.equal(reset.error, undefined);
  assert.equal(reset.state.circuit.halted, false);
  assert.equal(emptyCircuit().halted, false);
});
