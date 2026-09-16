import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSeoul, formatSeoulDate, formatSeoulTime } from "./format";

test("Seoul time format is timezone-fixed and padded", () => {
  const utcNoon = Date.UTC(2026, 8, 16, 12, 0, 0);
  assert.equal(formatSeoulTime(utcNoon), "21:00:00");
  assert.equal(formatSeoulTime(new Date(utcNoon).toISOString()), "21:00:00");
  assert.equal(formatSeoul(utcNoon), "09. 16. 21:00:00");
  assert.equal(formatSeoulDate(utcNoon), "2026. 09. 16.");
});

test("Seoul midnight does not depend on the host timezone", () => {
  const seoulMidnight = Date.UTC(2026, 8, 15, 15, 0, 0);
  assert.equal(formatSeoulTime(seoulMidnight), "00:00:00");
  const justAfterUtcMidnight = Date.UTC(2026, 8, 16, 0, 5, 9);
  assert.equal(formatSeoulTime(justAfterUtcMidnight), "09:05:09");
  assert.equal(formatSeoulTime(Number.NaN), "");
});
