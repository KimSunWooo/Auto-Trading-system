import assert from "node:assert/strict";
import test from "node:test";
import { OrderManager } from "./OrderManager";
import type { StateBox } from "./StateBox";
import { createInitialState } from "@/lib/engine";
import { MockBroker } from "@/src/brokers/MockBroker";
import { withNow } from "@/src/clock";
import {
  bandLimitPrice,
  forbidsMarketOrder,
  planBandSlices,
  sessionBlockReason,
  splitQty,
} from "./execution-policy";

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

test("session interceptor blocks mock orders when ignoreMarketHours is off", async () => {
  await withNow(Date.UTC(2026, 8, 15, 6, 20, 0), () => {
    const box: StateBox = { current: createInitialState() };
    box.current.settings.ignoreMarketHours = false;
    const reason = sessionBlockReason(box.current);
    assert.match(reason ?? "", /09:00~15:20/);
    const fill = new OrderManager(box).buy("Level1_Stable", "005930", 1, 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /동시호가|정규장/);
  });
});

test("band slices cap each ticket and use a -3% sell limit", () => {
  const slices = planBandSlices("sell", 10, 70_000);
  assert.deepEqual(
    slices.map((row) => row.qty),
    [7, 3],
  );
  assert.ok(slices.every((row) => row.ordDvsn === "limit"));
  assert.equal(slices[0]?.price, bandLimitPrice("sell", 70_000));
  assert.ok((slices[0]?.price ?? 0) < 70_000);
  assert.ok((slices[0]?.price ?? 0) >= 70_000 * 0.97 - 100);
});

test("splitQty keeps a 1-share slice when the name is more expensive than the cap", () => {
  assert.deepEqual(splitQty(3, 600_000), [1, 1, 1]);
});

test("247540 and similar names forbid market orders", () => {
  assert.equal(forbidsMarketOrder("247540"), true);
  assert.equal(forbidsMarketOrder("005930"), false);
  assert.equal(OrderManager.forbidsMarketOrder("086520"), true);
});

test("MockBroker rewrites a 247540 market buy to a limit band", async () => {
  const box: StateBox = { current: createInitialState() };
  const last = box.current.quotes["247540"]!.price;
  const fill = await new MockBroker(box, "Level1_Stable").buyMarket("247540", last * 2);
  assert.equal(fill.ok, true);
  assert.equal(box.current.orders[0]?.ordDvsn, "limit");
  assert.ok((box.current.orders[0]?.price ?? 0) >= last);
});
