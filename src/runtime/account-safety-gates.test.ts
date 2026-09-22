/**
 * Account-scoped Startup Sync + worker-lock gates (no live orders).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, before, test } from "node:test";
import { createInitialState } from "@/lib/engine";
import type { AppState } from "@/lib/types";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import {
  markProcessBootStartupVerified,
  resetProcessBootStartupForTest,
  startupSyncBlocksTrading,
  emptyStartupSync,
} from "@/src/runtime/startup-sync";
import {
  markScopeStartupSyncDone,
  resetRuntimeScopesForTest,
  isScopeStartupSyncDone,
} from "@/src/runtime/runtime-scope";
import {
  preTradeGate,
  autoStopReason,
  workerLockAllowsTrading,
} from "@/src/runtime/controlled-run";
import {
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
  releaseWorkerLock,
  workerLockHealthy,
} from "@/src/runtime/worker-lock";
import type { TradingSafetyContext } from "@/src/runtime/trading-safety";

const PAPER_ENV = {
  TRADING_MODE: "live_test",
  BROKER: "kis",
  KIS_MODE: "paper",
  PERSISTENCE_MODE: "mirror",
} as const;

const TMP = path.join(process.cwd(), "data", "test-account-safety-gates");

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));

afterEach(() => {
  resetRuntimeScopesForTest();
  resetProcessBootStartupForTest();
  resetWorkerLockForTest();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
});

function healthyState(overrides: Partial<AppState> = {}): AppState {
  const base = createInitialState();
  return {
    ...base,
    startupSync: {
      ...emptyStartupSync(),
      status: "HEALTHY",
      lastSyncedAt: new Date().toISOString(),
      message: "ok",
    },
    ...overrides,
  };
}

test("S1/S2 account startup flags are independent", () => {
  markScopeStartupSyncDone("acct-a", true);
  markScopeStartupSyncDone("acct-b", false);
  const stateA = healthyState();
  const stateB = healthyState();
  assert.equal(
    startupSyncBlocksTrading(stateA, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-a"),
    }),
    null,
  );
  assert.match(
    startupSyncBlocksTrading(stateB, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-b"),
    }) ?? "",
    /Account Startup Sync|Startup Sync/,
  );

  markScopeStartupSyncDone("acct-a", false);
  markScopeStartupSyncDone("acct-b", true);
  assert.match(
    startupSyncBlocksTrading(stateA, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-a"),
    }) ?? "",
    /Account Startup Sync|Startup Sync/,
  );
  assert.equal(
    startupSyncBlocksTrading(stateB, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-b"),
    }),
    null,
  );
});

test("S3 persisted HEALTHY alone cannot authorize; account flag required", () => {
  markScopeStartupSyncDone("acct-a", false);
  const state = healthyState();
  assert.equal(state.startupSync?.status, "HEALTHY");
  assert.match(
    startupSyncBlocksTrading(state, PAPER_ENV, { bootVerified: false }) ?? "",
    /Account Startup Sync|Startup Sync/,
  );
});

test("S4 FAILED blocks even when account flag is true", () => {
  markScopeStartupSyncDone("acct-a", true);
  const state = healthyState({
    startupSync: {
      ...emptyStartupSync(),
      status: "FAILED",
      message: "recon failed",
    },
  });
  assert.match(
    startupSyncBlocksTrading(state, PAPER_ENV, { bootVerified: true }) ?? "",
    /FAILED/,
  );
});

test("S5 bootstrap process READY does not leak into account runtime", () => {
  markProcessBootStartupVerified(true);
  markScopeStartupSyncDone("acct-a", false);
  const state = healthyState();
  assert.match(
    startupSyncBlocksTrading(state, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-a"),
    }) ?? "",
    /Account Startup Sync|Startup Sync/,
  );
});

test("S6 account READY is independent of bootstrap process flag=false", () => {
  markProcessBootStartupVerified(false);
  markScopeStartupSyncDone("acct-a", true);
  const state = healthyState();
  assert.equal(
    startupSyncBlocksTrading(state, PAPER_ENV, {
      bootVerified: isScopeStartupSyncDone("acct-a"),
    }),
    null,
  );
  // Bootstrap path without explicit bootVerified still blocked by process flag.
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /Process boot|Startup Sync/);
});

test("W1/W2 account lock paths do not authorize each other", () => {
  mkdirSync(TMP, { recursive: true });
  const lockA = path.join(TMP, "A.lock");
  const lockB = path.join(TMP, "B.lock");
  for (const p of [lockA, lockB]) {
    if (existsSync(p)) unlinkSync(p);
  }
  assert.equal(tryAcquireWorkerLock("wa", { filePath: lockA, ttlMs: 60_000 }), true);
  const safetyA: TradingSafetyContext = { workerLockPath: lockA };
  const safetyB: TradingSafetyContext = { workerLockPath: lockB };
  assert.equal(workerLockAllowsTrading(safetyA), true);
  assert.equal(workerLockAllowsTrading(safetyB), false);

  releaseWorkerLock("wa", { filePath: lockA });
  assert.equal(tryAcquireWorkerLock("wb", { filePath: lockB, ttlMs: 60_000 }), true);
  assert.equal(workerLockAllowsTrading(safetyA), false);
  assert.equal(workerLockAllowsTrading(safetyB), true);
  releaseWorkerLock("wb", { filePath: lockB });
});

test("W3 stale account lock blocks that account only", () => {
  mkdirSync(TMP, { recursive: true });
  const lockA = path.join(TMP, "A-stale.lock");
  const lockB = path.join(TMP, "B-fresh.lock");
  writeFileSync(
    lockA,
    JSON.stringify({ workerId: "wa", pid: 1, lockedAt: 0, heartbeatAt: 0 }),
    "utf8",
  );
  assert.equal(tryAcquireWorkerLock("wb", { filePath: lockB, ttlMs: 60_000 }), true);
  assert.equal(workerLockHealthy({ filePath: lockA, ttlMs: 1 }), false);
  assert.equal(workerLockAllowsTrading({ workerLockPath: lockA }), false);
  assert.equal(workerLockAllowsTrading({ workerLockPath: lockB }), true);
  releaseWorkerLock("wb", { filePath: lockB });
});

test("W5 bootstrap lock healthy does not authorize account missing lock", () => {
  mkdirSync(TMP, { recursive: true });
  const bootstrap = path.join(TMP, "bootstrap.lock");
  const accountA = path.join(TMP, "account-a.lock");
  if (existsSync(accountA)) unlinkSync(accountA);
  assert.equal(tryAcquireWorkerLock("boot", { filePath: bootstrap, ttlMs: 60_000 }), true);
  assert.equal(workerLockAllowsTrading(), true);
  assert.equal(workerLockAllowsTrading({ workerLockPath: accountA }), false);
  releaseWorkerLock("boot", { filePath: bootstrap });
});

test("preTradeGate + autoStopReason use account lockPath not any-lock", () => {
  mkdirSync(TMP, { recursive: true });
  const lockA = path.join(TMP, "pta.lock");
  const lockB = path.join(TMP, "ptb.lock");
  for (const p of [lockA, lockB]) {
    if (existsSync(p)) unlinkSync(p);
  }
  assert.equal(tryAcquireWorkerLock("wb", { filePath: lockB, ttlMs: 60_000 }), true);
  const state = healthyState();
  const blockedA = preTradeGate(
    state,
    { side: "buy", ticker: "005930", qty: 1 },
    PAPER_ENV,
    { workerLockPath: lockA },
  );
  assert.equal(blockedA.ok, false);
  if (!blockedA.ok) assert.match(blockedA.blocked, /워커 락|worker/i);

  assert.equal(autoStopReason(state, PAPER_ENV, { workerLockPath: lockA }), "Worker lock lost");
  assert.equal(autoStopReason(state, PAPER_ENV, { workerLockPath: lockB }), null);
  releaseWorkerLock("wb", { filePath: lockB });
});
