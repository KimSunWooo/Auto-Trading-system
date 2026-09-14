import assert from "node:assert/strict";
import test from "node:test";
import { OrderManager } from "./OrderManager";
import type { StateBox } from "./StateBox";
import { createInitialState } from "@/lib/engine";

test("OrderManager rejects a buy that exceeds the strategy bucket", () => {
  const box: StateBox = { current: createInitialState() };
  const tiny = box.current.allocations.find((a) => a.strategy === "Level1_Stable");
  assert.ok(tiny);
  tiny.balance = 1_000;
  tiny.budget = 1_000;
  box.current.cash = box.current.allocations.reduce((s, a) => s + a.balance, 0);

  const fill = new OrderManager(box).buy("Level1_Stable", "005930", 10, 74800);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /잔액/);
});

test("OrderManager fills inside the named bucket only", () => {
  const box: StateBox = { current: createInitialState() };
  const beforeAggressive = box.current.allocations.find(
    (a) => a.strategy === "Level10_Aggressive",
  )!.balance;
  const fill = new OrderManager(box).buy("Level1_Stable", "005930", 1, 70000);
  assert.equal(fill.ok, true);
  const level1 = box.current.allocations.find((a) => a.strategy === "Level1_Stable")!;
  const aggressive = box.current.allocations.find((a) => a.strategy === "Level10_Aggressive")!;
  assert.ok(level1.balance < 7_000_000);
  assert.equal(aggressive.balance, beforeAggressive);
  assert.equal(box.current.positions[0]?.strategy, "Level1_Stable");
});
