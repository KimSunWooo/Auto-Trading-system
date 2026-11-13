import assert from "node:assert/strict";
import test from "node:test";
import { fillHistoryRange } from "./repositories/fill-history";

test("fill history range uses KST day boundaries across UTC midnight", () => {
  // 2026-11-11 00:00 KST == 2026-11-10 15:00 UTC
  const range = fillHistoryRange(7, new Date("2026-11-10T15:00:00Z"));
  assert.equal(range.fromDate, "2026-11-05");
  assert.equal(range.throughDate, "2026-11-11");
  assert.equal(range.fromUtc, "2026-11-04 15:00:00.000000");
  assert.equal(range.untilUtc, "2026-11-11 15:00:00.000000");
});
