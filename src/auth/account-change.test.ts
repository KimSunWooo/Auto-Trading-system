/**
 * Account-number change mode helpers (no live KIS).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

function normalizeAccountNo(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function accountChangeMode(prevAccountNo: string | null | undefined, nextAccountNo: string): "rotate" | "switch" {
  const prev = (prevAccountNo ?? "").trim();
  const next = nextAccountNo.trim();
  if (!prev || normalizeAccountNo(prev) === normalizeAccountNo(next)) return "rotate";
  return "switch";
}

test("same account number (ignoring dashes/spaces) → rotate", () => {
  assert.equal(accountChangeMode("50123456-01", "50123456-01"), "rotate");
  assert.equal(accountChangeMode("50123456-01", "5012345601"), "rotate");
  assert.equal(accountChangeMode("5012 3456-01", "50123456-01"), "rotate");
});

test("missing previous secret → rotate in place", () => {
  assert.equal(accountChangeMode(null, "50123456-01"), "rotate");
  assert.equal(accountChangeMode("", "50123456-01"), "rotate");
});

test("different account number → switch to new brokerAccountId", () => {
  assert.equal(accountChangeMode("50123456-01", "50999999-01"), "switch");
});
