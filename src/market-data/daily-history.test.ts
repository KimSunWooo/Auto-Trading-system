import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeLiveIntoDailyBars,
  mergeLiveIntoDailyCloses,
  seoulTradeDate,
} from "@/src/market-data/daily-history";

test("same trade day updates the single developing bar", () => {
  const merged = mergeLiveIntoDailyBars(
    [
      { tradeDate: "20261107", close: 100 },
      { tradeDate: "20261110", close: 102 },
    ],
    { tradeDate: "20261110", price: 105 },
  );
  assert.deepEqual(
    merged.map((b) => [b.tradeDate, b.close]),
    [
      ["20261107", 100],
      ["20261110", 105],
    ],
  );
});

test("same close on a new trade day appends a new bar", () => {
  const merged = mergeLiveIntoDailyBars(
    [
      { tradeDate: "20261107", close: 100 },
      { tradeDate: "20261110", close: 102 },
    ],
    { tradeDate: "20261111", price: 102 },
  );
  assert.equal(merged.length, 3);
  assert.equal(merged[2]?.tradeDate, "20261111");
  assert.equal(merged[2]?.close, 102);
});

test("undated mergeLiveIntoDailyCloses does not invent a day from live ticks", () => {
  assert.deepEqual(mergeLiveIntoDailyCloses([1, 2, 3], 4), [1, 2, 3]);
  assert.deepEqual(mergeLiveIntoDailyCloses([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(mergeLiveIntoDailyCloses([], 10), []);
});

test("dated opts path updates same day and appends next day", () => {
  const sameDay = mergeLiveIntoDailyCloses([100, 101], 102, {
    dailyTradeDates: ["20261109", "20261110"],
    liveTradeDate: "20261110",
  });
  assert.deepEqual(sameDay, [100, 102]);
  const nextDay = mergeLiveIntoDailyCloses([100, 101], 101, {
    dailyTradeDates: ["20261109", "20261110"],
    liveTradeDate: "20261111",
  });
  assert.deepEqual(nextDay, [100, 101, 101]);
});

test("seoulTradeDate returns YYYYMMDD", () => {
  assert.match(seoulTradeDate(Date.UTC(2026, 10, 10, 3, 0, 0)), /^20261110$/);
});
