import assert from "node:assert/strict";
import test from "node:test";
import { OrderManager } from "./OrderManager";
import type { StateBox } from "./StateBox";
import { createInitialState, createPaperState } from "@/lib/engine";
import { MockBroker } from "@/src/brokers/MockBroker";
import { withNow } from "@/src/clock";
import {
  bandLimitPrice,
  forbidsMarketOrder,
  planBandSlices,
  sessionBlockReason,
  splitQty,
} from "./execution-policy";

test("OrderManager rejects a buy that exceeds the rule bucket", () => {
  const box: StateBox = { current: createPaperState() };
  const tiny = box.current.allocations.find((a) => a.ruleId === "cash");
  assert.ok(tiny);
  tiny.balance = 1_000;
  tiny.budget = 1_000;
  box.current.cash = box.current.allocations.reduce((s, a) => s + a.balance, 0);

  const fill = new OrderManager(box).buy("cash", "005930", 10, 74800);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /잔액/);
});

test("OrderManager fills inside the named bucket only", () => {
  const box: StateBox = { current: createPaperState() };
  box.current.allocations = [
    { ruleId: "cash", budget: 1_000_000, balance: 1_000_000, enabled: true },
    { ruleId: "rule-a", budget: 7_000_000, balance: 7_000_000, enabled: true },
    { ruleId: "rule-b", budget: 2_000_000, balance: 2_000_000, enabled: true },
  ];
  box.current.cash = 10_000_000;
  const beforeB = box.current.allocations.find((a) => a.ruleId === "rule-b")!.balance;
  const fill = new OrderManager(box).buy("rule-a", "005930", 1, 70000);
  assert.equal(fill.ok, true);
  const ruleA = box.current.allocations.find((a) => a.ruleId === "rule-a")!;
  const ruleB = box.current.allocations.find((a) => a.ruleId === "rule-b")!;
  assert.ok(ruleA.balance < 7_000_000);
  assert.equal(ruleB.balance, beforeB);
  assert.equal(box.current.positions[0]?.ruleId, "rule-a");
});

test("OrderManager locks buys until the user accepts the disclaimer", () => {
  const box: StateBox = { current: createInitialState() };
  const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /이용 동의/);
});

test("session interceptor blocks mock orders when ignoreMarketHours is off", async () => {
  await withNow(Date.UTC(2026, 8, 15, 6, 20, 0), () => {
    const box: StateBox = { current: createPaperState() };
    box.current.settings.ignoreMarketHours = false;
    const reason = sessionBlockReason(box.current);
    assert.match(reason ?? "", /09:00~15:20/);
    const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
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
  const box: StateBox = { current: createPaperState() };
  const last = box.current.quotes["247540"]!.price;
  const fill = await new MockBroker(box, "cash").buyMarket("247540", last * 2);
  assert.equal(fill.ok, true);
  assert.equal(box.current.orders[0]?.ordDvsn, "limit");
  assert.ok((box.current.orders[0]?.price ?? 0) >= last);
});
