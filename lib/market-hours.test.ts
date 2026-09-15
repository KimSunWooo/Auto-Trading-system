import assert from "node:assert/strict";
import test from "node:test";
import { getMarketClock, isRegularSession } from "./market-hours";

function kst(isoUtc: string) {
  return getMarketClock(new Date(isoUtc));
}

test("regular session is weekday 09:00 inclusive to 15:20 exclusive", () => {
  const open = kst("2026-09-15T00:00:00.000Z"); // 09:00 KST Tue
  assert.equal(open.open, true);
  assert.equal(open.sessionLabel, "정규장");
  assert.equal(isRegularSession(open.now), true);

  const lastMinute = kst("2026-09-15T06:19:00.000Z"); // 15:19 KST
  assert.equal(lastMinute.open, true);

  const closeAuction = kst("2026-09-15T06:20:00.000Z"); // 15:20 KST
  assert.equal(closeAuction.open, false);
  assert.equal(closeAuction.sessionLabel, "동시호가");
});

test("opening auction and after-hours are not regular session", () => {
  const opening = kst("2026-09-14T23:50:00.000Z"); // 08:50 KST Tue
  assert.equal(opening.open, false);
  assert.equal(opening.sessionLabel, "동시호가");

  const after = kst("2026-09-15T07:00:00.000Z"); // 16:00 KST
  assert.equal(after.open, false);
  assert.equal(after.sessionLabel, "시간외");

  const weekend = kst("2026-09-13T01:00:00.000Z"); // 10:00 KST Sun
  assert.equal(weekend.open, false);
  assert.equal(weekend.sessionLabel, "주말 휴장");
});
