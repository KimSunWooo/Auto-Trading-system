import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { OrderManager } from "./OrderManager";
import type { StateBox } from "./StateBox";
import { createInitialState } from "@/lib/engine";
import { FakeBroker, makeTestPaperState } from "@/src/test-support";
import { setNowMs, withNow } from "@/src/clock";
import {
  SEOUL_CLOSING_AUCTION_MS,
  SEOUL_HOLIDAY_MS,
  SEOUL_OPENING_AUCTION_MS,
  SEOUL_REGULAR_SESSION_MS,
  SEOUL_WEEKEND_MS,
} from "@/lib/market-hours";
import {
  bandLimitPrice,
  forbidsMarketOrder,
  planBandSlices,
  sessionBlockReason,
  splitQty,
} from "./execution-policy";
import { RULE_THROTTLE_MS } from "@/src/rules/throttle";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

test("OrderManager rejects a buy that exceeds the rule bucket", () => {
  const box: StateBox = { current: makeTestPaperState() };
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
  const box: StateBox = { current: makeTestPaperState() };
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

test("session interceptor blocks mock orders even when ignoreMarketHours is on", async () => {
  await withNow(SEOUL_CLOSING_AUCTION_MS, () => {
    const box: StateBox = { current: makeTestPaperState() };
    box.current.settings.ignoreMarketHours = true;
    const reason = sessionBlockReason(box.current);
    assert.match(reason ?? "", /09:00~15:20/);
    assert.match(reason ?? "", /동시호가/);
    const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /동시호가|정규장/);
  });
});

test("session interceptor rejects opening auction, weekends, and KRX holidays", async () => {
  await withNow(SEOUL_OPENING_AUCTION_MS, () => {
    const box: StateBox = { current: makeTestPaperState() };
    const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /동시호가|정규장/);
  });
  await withNow(SEOUL_WEEKEND_MS, () => {
    const box: StateBox = { current: makeTestPaperState() };
    const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /주말|정규장/);
  });
  await withNow(SEOUL_HOLIDAY_MS, () => {
    const box: StateBox = { current: makeTestPaperState() };
    const fill = new OrderManager(box).buy("cash", "005930", 1, 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /공휴일|정규장/);
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

test("all names forbid naked market orders", () => {
  assert.equal(forbidsMarketOrder("247540"), true);
  assert.equal(forbidsMarketOrder("005930"), true);
  assert.equal(OrderManager.forbidsMarketOrder("086520"), true);
});

test("FakeBroker rewrites a 247540 market buy to a limit band", async () => {
  const box: StateBox = { current: makeTestPaperState() };
  const last = box.current.quotes["247540"]!.price;
  const fill = await new FakeBroker(box, "cash").buyMarket("247540", last * 2);
  assert.equal(fill.ok, true);
  assert.equal(box.current.orders[0]?.ordDvsn, "limit");
  assert.ok((box.current.orders[0]?.price ?? 0) >= last);
});

test("FakeBroker rewrites a 005930 market buy to a ±3% limit", async () => {
  const box: StateBox = { current: makeTestPaperState() };
  const last = box.current.quotes["005930"]!.price;
  const fill = await new FakeBroker(box, "cash").buyMarket("005930", last * 2);
  assert.equal(fill.ok, true);
  assert.equal(box.current.orders[0]?.ordDvsn, "limit");
  assert.equal(fill.qty, 2);
  const band = bandLimitPrice("buy", last);
  assert.ok(band >= last);
  assert.ok(band <= last * 1.03 + 100);
});

test("two consecutive rule rejects lock the rule for 3 minutes", () => {
  const box: StateBox = { current: makeTestPaperState() };
  const cash = box.current.allocations.find((a) => a.ruleId === "cash")!;
  cash.balance = 1_000;
  cash.budget = 1_000;
  box.current.cash = box.current.allocations.reduce((s, a) => s + a.balance, 0);
  const orders = new OrderManager(box);
  const first = orders.buy("cash", "005930", 1, 70_000);
  const second = orders.buy("cash", "005930", 1, 70_000);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.match(first.reason ?? "", /잔액/);
  const third = orders.buy("cash", "005930", 1, 70_000);
  assert.equal(third.ok, false);
  assert.match(third.reason ?? "", /쿨다운/);
  assert.ok(Number(box.current.allocations.find((a) => a.ruleId === "cash")?.meta?.throttleUntilMs) > SEOUL_REGULAR_SESSION_MS);
});

test("a fill clears the rule fail streak", () => {
  const box: StateBox = { current: makeTestPaperState() };
  const orders = new OrderManager(box);
  box.current.allocations = box.current.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: 1_000 } : row,
  );
  const miss = orders.buy("cash", "005930", 1, 70_000);
  assert.equal(miss.ok, false);
  box.current.allocations = box.current.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: 5_000_000 } : row,
  );
  const hit = orders.buy("cash", "005930", 1, 70_000);
  assert.equal(hit.ok, true);
  box.current.allocations = box.current.allocations.map((row) =>
    row.ruleId === "cash" ? { ...row, balance: 1_000 } : row,
  );
  const again = orders.buy("cash", "005930", 1, 70_000);
  assert.equal(again.ok, false);
  assert.match(again.reason ?? "", /잔액/);
  assert.equal(again.reason?.includes("쿨다운"), false);
});

test("rule cooldown expires after 3 minutes", async () => {
  const box: StateBox = { current: makeTestPaperState() };
  const cash = box.current.allocations.find((a) => a.ruleId === "cash")!;
  cash.balance = 1_000;
  const orders = new OrderManager(box);
  orders.buy("cash", "005930", 1, 70_000);
  orders.buy("cash", "005930", 1, 70_000);
  assert.match(orders.buy("cash", "005930", 1, 70_000).reason ?? "", /쿨다운/);
  await withNow(SEOUL_REGULAR_SESSION_MS + RULE_THROTTLE_MS + 1, () => {
    const next = orders.buy("cash", "005930", 1, 70_000);
    assert.equal(next.ok, false);
    assert.match(next.reason ?? "", /잔액/);
    assert.equal(next.reason?.includes("쿨다운"), false);
  });
});
