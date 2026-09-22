/**
 * KIS observation cadence — preserve pre-trade freshness, throttle background balance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HARD_LIMITS } from "@/src/risk/limits";
import {
  recordKisQueryTelemetry,
  resetKisQueryTelemetryForTest,
  summarizeKisQueryTelemetry,
} from "@/src/runtime/kis-query-telemetry";

test("observation balance cadence uses 30s HARD_LIMITS (not every tick)", () => {
  assert.equal(HARD_LIMITS.balanceSyncMs, 30_000);
  assert.ok(HARD_LIMITS.minTickMs < HARD_LIMITS.balanceSyncMs);
});

test("telemetry summary counts categories without inventing order posts", () => {
  resetKisQueryTelemetryForTest();
  recordKisQueryTelemetry({
    category: "balance",
    latencyMs: 12,
    ok: true,
    timeout: false,
    rateLimited: false,
  });
  recordKisQueryTelemetry({
    category: "quote",
    latencyMs: 8,
    ok: true,
    timeout: false,
    rateLimited: false,
    ticker: "005930",
  });
  recordKisQueryTelemetry({
    category: "balance",
    latencyMs: 40,
    ok: false,
    timeout: false,
    rateLimited: true,
  });
  const summary = summarizeKisQueryTelemetry();
  assert.equal(summary.total, 3);
  assert.equal(summary.byCategory.balance, 2);
  assert.equal(summary.byCategory.quote, 1);
  assert.equal(summary.rateLimited, 1);
  assert.equal(summary.failures, 1);
  // Orders are never telemetry categories for POST lifecycle.
  assert.equal(summary.byCategory.psbl_order, 0);
  resetKisQueryTelemetryForTest();
});
