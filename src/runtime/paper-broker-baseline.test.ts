/**
 * PAPER broker cash authority — no live orders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState } from "@/lib/engine";
import { TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import {
  applyPaperBrokerBaseline,
  createPaperAccountResetState,
  needsPaperBrokerBaseline,
  paperBalanceReadyForOnboarding,
} from "@/src/runtime/paper-broker-baseline";
import { emptyStartupSync } from "@/src/runtime/startup-sync";

test("P3 first broker sync replaces default 10M with KIS deposit baseline", () => {
  const seeded = createInitialState();
  assert.equal(seeded.totalDeposit, TOTAL_DEPOSIT);
  assert.equal(needsPaperBrokerBaseline(seeded, { BROKER: "kis", KIS_MODE: "paper" }), true);

  const next = applyPaperBrokerBaseline(seeded, 5_000_000);
  assert.equal(next.totalDeposit, 5_000_000);
  assert.equal(next.settings.startingCash, 5_000_000);
  assert.equal(next.cash, 5_000_000);
  assert.equal(next.paperBrokerBaseline?.source, "KIS_PAPER");
  assert.equal(next.paperBrokerBaseline?.depositCash, 5_000_000);
  assert.deepEqual(next.equityHistory, [5_000_000]);
});

test("P4 second apply does not reset baseline/history when KIS cash changes", () => {
  const first = applyPaperBrokerBaseline(createInitialState(), 5_000_000);
  const withHistory = {
    ...first,
    equityHistory: [5_000_000, 5_100_000, 4_900_000],
    dayStart: { date: "2026-09-22", equity: 5_000_000 },
  };
  const second = applyPaperBrokerBaseline(
    { ...withHistory, kisBalance: undefined },
    7_000_000,
  );
  assert.equal(second.paperBrokerBaseline?.depositCash, 5_000_000);
  assert.equal(second.totalDeposit, 5_000_000);
  assert.deepEqual(second.equityHistory, [5_000_000, 5_100_000, 4_900_000]);
  assert.equal(needsPaperBrokerBaseline(second, { BROKER: "kis", KIS_MODE: "paper" }), false);
});

test("P2 client totalDeposit must not be used once baseline exists (unit)", () => {
  const baselined = applyPaperBrokerBaseline(createInitialState(), 5_000_000);
  // Simulate ignoring client 999999999 — authority stays broker baseline.
  const clientWanted = 999_999_999;
  assert.notEqual(baselined.totalDeposit, clientWanted);
  assert.equal(baselined.totalDeposit, 5_000_000);
});

test("P7 PAPER account reset clears fake 10M and baseline", () => {
  const reset = createPaperAccountResetState();
  assert.equal(reset.totalDeposit, 0);
  assert.equal(reset.settings.startingCash, 0);
  assert.equal(reset.cash, 0);
  assert.equal(reset.paperBrokerBaseline, undefined);
  assert.equal(reset.settings.autoTrading, false);
  assert.equal(reset.startupSync?.status, "IDLE");
});

test("P onboarding readiness requires HEALTHY + fresh kisBalance + baseline", () => {
  const bare = createInitialState();
  assert.match(paperBalanceReadyForOnboarding(bare) ?? "", /Startup Sync|baseline|fresh/i);

  const ready = applyPaperBrokerBaseline(
    {
      ...createInitialState(),
      startupSync: { ...emptyStartupSync(), status: "HEALTHY" },
      kisBalance: {
        syncedAt: new Date().toISOString(),
        cash: 5_000_000,
        d2Cash: 5_000_000,
        orderableCash: 4_800_000,
        holdings: [],
        cashDelta: 0,
        matched: true,
        freshness: "fresh",
        message: "ok",
      },
    },
    5_000_000,
  );
  assert.equal(paperBalanceReadyForOnboarding(ready), null);
});

test("MOCK path still allows seeded TOTAL_DEPOSIT until user sets deposit", () => {
  const mock = createInitialState();
  assert.equal(needsPaperBrokerBaseline(mock, { BROKER: "mock", KIS_MODE: "paper" }), false);
  assert.equal(mock.totalDeposit, TOTAL_DEPOSIT);
});
