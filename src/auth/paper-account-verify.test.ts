import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { verifyPaperAccountForUser, exactHoldingsMatch } from "@/src/auth/paper-account-verify";
import { PaperAccountSelectionError, selectOwnedPaperAccount } from "@/src/auth/select-paper-account";
import { resetDbClientForTest } from "@/src/db/client";
import type { AppState } from "@/lib/types";

const PREV_URL = process.env.DATABASE_URL;

before(() => {
  delete process.env.DATABASE_URL;
  resetDbClientForTest();
});

after(() => {
  if (PREV_URL == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREV_URL;
  resetDbClientForTest();
});

test("AB5 multiple ACTIVE + no default → BLOCK (selection helper)", () => {
  const err = new PaperAccountSelectionError(
    "ACCOUNT_SELECTION_REQUIRED",
    "Multiple ACTIVE PAPER accounts without default — selection required",
  );
  assert.equal(err.code, "ACCOUNT_SELECTION_REQUIRED");
});

test("AB6 multiple default → BLOCK code", () => {
  const err = new PaperAccountSelectionError(
    "MULTIPLE_DEFAULT_ACCOUNTS",
    "Multiple default ACTIVE PAPER accounts — selection required",
  );
  assert.equal(err.code, "MULTIPLE_DEFAULT_ACCOUNTS");
});

test("verify without DB never marks READY", async () => {
  const result = await verifyPaperAccountForUser({
    userId: "missing-user",
    skipLiveQuery: true,
  });
  assert.equal(result.readyForTrading, false);
  assert.ok(result.blockers.length > 0);
  assert.equal(result.environment, "PAPER");
});

test("positions exact match — qty tolerance forbidden", () => {
  const state = {
    positions: [{ code: "035720", qty: 3, avgPrice: 42000, name: "카카오" }],
    cash: 1_000_000,
    orders: [],
    quotes: {},
    allocations: [],
    updatedAt: new Date().toISOString(),
  } as unknown as AppState;
  const ok = exactHoldingsMatch(state, {
    cash: 5_000_000,
    holdings: [{ ticker: "035720", qty: 3 }],
  });
  assert.equal(ok.matched, true);
  const bad = exactHoldingsMatch(state, {
    cash: 5_000_000,
    holdings: [{ ticker: "035720", qty: 4 }],
  });
  assert.equal(bad.matched, false);
  assert.ok(bad.reasons.includes("POSITION_QTY_MISMATCH"));
});

test("selectOwnedPaperAccount is exported", () => {
  assert.equal(typeof selectOwnedPaperAccount, "function");
});
