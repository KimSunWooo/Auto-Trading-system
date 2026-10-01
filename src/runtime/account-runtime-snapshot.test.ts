import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, test } from "node:test";
import path from "node:path";
import { createPaperState } from "@/lib/engine";
import {
  accountWorkerLockPath,
  buildAccountRuntimeSnapshot,
} from "@/src/runtime/account-runtime-snapshot";
import { markScopeStartupSyncDone } from "@/src/runtime/runtime-scope";
import {
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import { emptyStartupSync } from "@/src/runtime/startup-sync";
import { buildRuntimePublic } from "@/src/runtime/status";

const dirs: string[] = [];
afterEach(() => {
  resetWorkerLockForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("snapshot uses account lock path and does not invent cash=0", () => {
  const accountId = "acct-snap-test-0001";
  const state = createPaperState();
  state.startupSync = {
    ...emptyStartupSync(),
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
  };
  state.kisBalance = {
    syncedAt: new Date().toISOString(),
    cash: 9_640_215,
    d2Cash: 9_640_215,
    orderableCash: 9_592_013,
    matched: true,
    holdings: [
      { ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 },
      { ticker: "069500", name: "KODEX 200", qty: 1, avgPrice: 106245 },
    ],
    cashDelta: 0,
    message: "ok",
  };
  state.safety = {
    ...(state.safety as object),
    kind: "ok",
    reconciliation: "synced",
    brokerConnected: true,
    quoteOk: true,
    persistable: true,
    tradingAllowed: true,
  } as typeof state.safety;

  markScopeStartupSyncDone(accountId, true);
  const lockPath = accountWorkerLockPath(accountId);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  dirs.push(path.dirname(lockPath));
  assert.equal(tryAcquireWorkerLock("w-snap", { filePath: lockPath }), true);

  const snap = buildAccountRuntimeSnapshot({ brokerAccountId: accountId, state });
  assert.equal(snap.cash, 9_640_215);
  assert.equal(snap.orderableCash, 9_592_013);
  assert.equal(snap.holdings.length, 2);
  assert.equal(snap.bootVerified, true);
  assert.equal(snap.workerLockHeld, true);
  assert.equal(snap.riskStatus, "READY");
  assert.equal(snap.workerLockPath, lockPath);

  const runtime = buildRuntimePublic(state, { brokerAccountId: accountId });
  assert.equal(runtime.worker, "healthy");
  assert.equal(runtime.risk, "normal");
  assert.equal(runtime.accountSnapshot?.cash, 9_640_215);

  releaseWorkerLock("w-snap", { filePath: lockPath });
});

test("missing kisBalance keeps cash null (UNAVAILABLE), not 0", () => {
  const accountId = "acct-null-cash";
  const state = createPaperState();
  state.kisBalance = undefined;
  markScopeStartupSyncDone(accountId, false);
  const snap = buildAccountRuntimeSnapshot({ brokerAccountId: accountId, state });
  assert.equal(snap.cash, null);
  assert.equal(snap.orderableCash, null);
  // Without PAPER startup env, tradingBlocked may not apply; cash null is the contract under test.
  assert.notEqual(snap.cash, 0);
});
