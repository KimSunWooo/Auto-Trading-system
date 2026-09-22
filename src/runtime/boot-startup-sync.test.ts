/**
 * Engine-loop boot sync: persisted HEALTHY must not skip fresh KIS sync.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import {
  emptyStartupSync,
  markProcessBootStartupVerified,
  resetProcessBootStartupForTest,
  startupSyncBlocksTrading,
} from "@/src/runtime/startup-sync";
import { resetStartupSyncFlagForTest } from "@/lib/engine-loop";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
} as const;

afterEach(() => {
  for (const key of Object.keys(PAPER_ENV)) delete process.env[key];
  resetProcessBootStartupForTest();
  resetStartupSyncFlagForTest();
});

test("R13: new process with persisted HEALTHY still blocks until boot verify", () => {
  Object.assign(process.env, PAPER_ENV);
  // Simulate production boot: process has not completed fresh sync.
  markProcessBootStartupVerified(false);
  const state = createPaperState();
  state.startupSync = {
    ...emptyStartupSync(),
    status: "HEALTHY",
    lastSyncedAt: "2026-09-20T00:00:00.000Z",
  };
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /Process boot/);
  markProcessBootStartupVerified(true);
  assert.equal(startupSyncBlocksTrading(state, PAPER_ENV), null);
});
