import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLiveIntoDailyCloses } from "@/src/market-data/daily-history";

test("does not append live price when it equals last daily close", () => {
  assert.deepEqual(mergeLiveIntoDailyCloses([100, 101, 102], 102), [100, 101, 102]);
});

test("appends live price when it differs from last daily close", () => {
  assert.deepEqual(mergeLiveIntoDailyCloses([100, 101, 102], 103), [100, 101, 102, 103]);
});

test("caps history length", () => {
  const daily = Array.from({ length: 50 }, (_, i) => i + 1);
  const merged = mergeLiveIntoDailyCloses(daily, 999, 40);
  assert.equal(merged.length, 40);
  assert.equal(merged[merged.length - 1], 999);
});
