/**
 * Account worker isolation tests — no live KIS orders.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createInitialState } from "@/lib/engine";
import { createTradingStateStore, resetTradingStateStoresForTest } from "@/src/runtime/trading-state-store";
import { createRuleConfigStore, resetRuleConfigStoresForTest } from "@/src/runtime/rule-config-store";
import {
  markScopeStartupSyncDone,
  resetRuntimeScopesForTest,
  isScopeStartupSyncDone,
} from "@/src/runtime/runtime-scope";
import {
  accountAutoTradingReady,
  stopAccountEngineLoopForTest,
} from "@/lib/account-engine-loop";
import {
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
  holdsWorkerLock,
  releaseWorkerLock,
} from "@/src/runtime/worker-lock";
import { blankRule } from "@/src/rules/params";

const TMP = path.join(process.cwd(), "data", "test-account-worker");

test("account locks are independent; A hold does not touch B lock file", () => {
  resetWorkerLockForTest();
  mkdirSync(TMP, { recursive: true });
  const lockA = path.join(TMP, "A-trading-worker.lock");
  const lockB = path.join(TMP, "B-trading-worker.lock");
  try {
    if (existsSync(lockA)) unlinkSync(lockA);
    if (existsSync(lockB)) unlinkSync(lockB);
  } catch {
    // ignore
  }
  assert.equal(tryAcquireWorkerLock("worker-a", { filePath: lockA }), true);
  assert.equal(holdsWorkerLock("worker-a"), true);
  assert.equal(existsSync(lockB), false);
  assert.equal(tryAcquireWorkerLock("worker-b", { filePath: lockB }), true);
  assert.equal(holdsWorkerLock("worker-b"), true);
  assert.equal(existsSync(lockA), true);
  assert.equal(existsSync(lockB), true);
  releaseWorkerLock("worker-a", { filePath: lockA });
  assert.equal(existsSync(lockA), false);
  assert.equal(existsSync(lockB), true);
  releaseWorkerLock("worker-b", { filePath: lockB });
  resetWorkerLockForTest();
});

test("startup sync flags are per-account", () => {
  resetRuntimeScopesForTest();
  markScopeStartupSyncDone("acct-a", true);
  assert.equal(isScopeStartupSyncDone("acct-a"), true);
  assert.equal(isScopeStartupSyncDone("acct-b"), false);
  markScopeStartupSyncDone("acct-b", false);
  assert.equal(isScopeStartupSyncDone("acct-a"), true);
  assert.equal(isScopeStartupSyncDone("acct-b"), false);
  resetRuntimeScopesForTest();
});

test("account state stores mutate independently", async () => {
  resetTradingStateStoresForTest();
  resetRuleConfigStoresForTest();
  mkdirSync(path.join(TMP, "A"), { recursive: true });
  mkdirSync(path.join(TMP, "B"), { recursive: true });
  const pathA = path.join(TMP, "A", "state-iso.json");
  const pathB = path.join(TMP, "B", "state-iso.json");
  writeFileSync(pathA, JSON.stringify(createInitialState()), "utf8");
  writeFileSync(pathB, JSON.stringify(createInitialState()), "utf8");
  const storeA = createTradingStateStore({ statePath: pathA });
  const storeB = createTradingStateStore({ statePath: pathB });
  assert.notEqual(storeA.statePath, storeB.statePath);
  const nextA = await storeA.mutateStore((s) => ({
    ...s,
    settings: { ...s.settings, autoTrading: true },
  }));
  assert.equal(nextA.settings.autoTrading, true);
  const stateB = await storeB.getState();
  assert.equal(stateB.settings.autoTrading, false);
  // Separate store instances — mutating A must not change B's in-memory queue result.
  const nextB = await storeB.mutateStore((s) => s);
  assert.equal(nextB.settings.autoTrading, false);
  resetTradingStateStoresForTest();
});

test("account rule stores are path-isolated", () => {
  resetRuleConfigStoresForTest();
  mkdirSync(path.join(TMP, "A"), { recursive: true });
  mkdirSync(path.join(TMP, "B"), { recursive: true });
  const rulesA = createRuleConfigStore(path.join(TMP, "A", "strategy-config.json"));
  const rulesB = createRuleConfigStore(path.join(TMP, "B", "strategy-config.json"));
  rulesA.save({
    rules: [blankRule({ id: "r1", name: "A only", ticker: "005930", enabled: true, budget: 1_000_000 })],
  });
  assert.equal(rulesA.get().rules.length, 1);
  assert.equal(rulesB.get().rules.length, 0);
  resetRuleConfigStoresForTest();
});

test("auto-trading activation requires full gate", () => {
  assert.equal(
    accountAutoTradingReady({
      autoTradingEnabled: true,
      startupSyncHealthy: true,
      lockHeld: true,
      hasUnknown: false,
      reconciliationHealthy: true,
    }),
    true,
  );
  assert.equal(
    accountAutoTradingReady({
      autoTradingEnabled: true,
      startupSyncHealthy: false,
      lockHeld: true,
      hasUnknown: false,
      reconciliationHealthy: true,
    }),
    false,
  );
  assert.equal(
    accountAutoTradingReady({
      autoTradingEnabled: false,
      startupSyncHealthy: true,
      lockHeld: true,
      hasUnknown: false,
      reconciliationHealthy: true,
    }),
    false,
  );
  stopAccountEngineLoopForTest();
});
