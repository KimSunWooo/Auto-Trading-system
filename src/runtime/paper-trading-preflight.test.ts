/**
 * PAPER trading preflight unit gates (no live KIS orders).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import {
  assertReadyToEnablePaperAutoTrading,
  evaluatePaperTradingPreflight,
} from "@/src/runtime/paper-trading-preflight";
import {
  configureWorkerLockPath,
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import { emptyStartupSync } from "@/src/runtime/startup-sync";

const PAPER_ENV = {
  BROKER: "kis",
  KIS_MODE: "paper",
  TRADING_MODE: "live_test",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_ACCOUNT_NO: "50123456-01",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
};

const dirs: string[] = [];
afterEach(() => {
  resetWorkerLockForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function healthyState() {
  const state = createPaperState();
  state.startupSync = {
    ...emptyStartupSync(),
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
  };
  state.safety = {
    ...(state.safety as object),
    kind: "ok",
    brokerConnected: true,
    reconciliation: "synced",
    quoteOk: true,
    persistable: true,
    tradingAllowed: true,
  } as typeof state.safety;
  state.kisBalance = {
    cash: 1_000_000,
    orderableCash: 900_000,
    matched: true,
    holdings: [],
    checkedAt: Date.now(),
  };
  // Fresh KIS quote
  const q = state.quotes["005930"];
  if (q) {
    q.source = "kis";
    q.freshAt = Date.now();
  }
  return state;
}

test("REAL env aborts paperModeConfirmed", () => {
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    bootStartupVerified: true,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: { ...PAPER_ENV, ALLOW_LIVE_TRADING: "true" },
  });
  assert.equal(pre.realTradingDisabled, false);
  assert.equal(pre.readyForPaperAutoTrading, false);
  assert.ok(pre.blockers.some((b) => b.includes("REAL") || b.includes("ALLOW_LIVE")));
});

test("startup sync IDLE blocks ready", () => {
  const state = healthyState();
  state.startupSync = { ...emptyStartupSync(), status: "IDLE" };
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state,
    brokerAccountId: "acct-1",
    bootStartupVerified: false,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(pre.startupSyncReady, false);
  assert.equal(pre.readyForPaperAutoTrading, false);
});

test("UNKNOWN order blocks ready", () => {
  const state = healthyState();
  state.orders.push({
    id: "unk-1",
    createdAt: new Date().toISOString(),
    source: "rule",
    code: "005930",
    name: "Samsung",
    side: "buy",
    qty: 1,
    price: 70000,
    amount: 70000,
    commission: 0,
    tax: 0,
    net: 0,
    status: "unknown",
    activeClass: "UNKNOWN_ACTIVE",
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-lock-"));
  dirs.push(dir);
  const lockPath = path.join(dir, "trading-worker.lock");
  configureWorkerLockPath(lockPath);
  tryAcquireWorkerLock("w1", { filePath: lockPath });
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state,
    brokerAccountId: "acct-1",
    workerLockPath: lockPath,
    bootStartupVerified: true,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(pre.unknownOrdersClear, false);
  assert.equal(pre.readyForPaperAutoTrading, false);
  releaseWorkerLock("w1", { filePath: lockPath });
});

test("worker lock missing blocks ready", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-lock-"));
  dirs.push(dir);
  const lockPath = path.join(dir, "trading-worker.lock");
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    workerLockPath: lockPath,
    bootStartupVerified: true,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(pre.workerLockReady, false);
  assert.equal(pre.readyForPaperAutoTrading, false);
});

test("all gates pass → readyForPaperAutoTrading", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-lock-"));
  dirs.push(dir);
  const lockPath = path.join(dir, "trading-worker.lock");
  configureWorkerLockPath(lockPath);
  assert.equal(tryAcquireWorkerLock("w1", { filePath: lockPath }), true);
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    workerLockPath: lockPath,
    bootStartupVerified: true,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(assertReadyToEnablePaperAutoTrading(pre), null);
  assert.equal(pre.readyForPaperAutoTrading, true);
  releaseWorkerLock("w1", { filePath: lockPath });
});

test("stale/mock quote blocks marketDataReady", () => {
  const state = healthyState();
  for (const q of Object.values(state.quotes)) {
    q.source = "mock";
    q.freshAt = Date.now();
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-lock-"));
  dirs.push(dir);
  const lockPath = path.join(dir, "trading-worker.lock");
  tryAcquireWorkerLock("w1", { filePath: lockPath });
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state,
    brokerAccountId: "acct-1",
    workerLockPath: lockPath,
    bootStartupVerified: true,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(pre.marketDataReady, false);
  assert.equal(pre.readyForPaperAutoTrading, false);
  releaseWorkerLock("w1", { filePath: lockPath });
});
