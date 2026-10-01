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
  clearPreflightInflightForTest,
  evaluatePaperTradingPreflight,
  preflightDomainErrorPayload,
} from "@/src/runtime/paper-trading-preflight";
import {
  configureWorkerLockPath,
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import { emptyStartupSync } from "@/src/runtime/startup-sync";
import {
  formatInstrumentLabel,
  instrumentNameCacheSizeForTest,
  resetInstrumentNameCacheForTest,
  resolveInstrumentMetadata,
} from "@/src/instruments/metadata";
import {
  isKisRateLimitMessage,
  KisRateLimitError,
  resetKisTokenCacheForTest,
} from "@/src/brokers/kis-client";

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
  clearPreflightInflightForTest();
  resetInstrumentNameCacheForTest();
  resetKisTokenCacheForTest();
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
    syncedAt: new Date().toISOString(),
    cash: 1_000_000,
    d2Cash: 1_000_000,
    orderableCash: 900_000,
    matched: true,
    holdings: [],
    cashDelta: 0,
    message: "ok",
  };
  const q = state.quotes["005930"];
  if (q) {
    q.source = "kis";
    q.freshAt = Date.now();
  }
  return state;
}

function withLock(run: (lockPath: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preflight-lock-"));
  dirs.push(dir);
  const lockPath = path.join(dir, "trading-worker.lock");
  configureWorkerLockPath(lockPath);
  assert.equal(tryAcquireWorkerLock("w1", { filePath: lockPath }), true);
  try {
    run(lockPath);
  } finally {
    releaseWorkerLock("w1", { filePath: lockPath });
  }
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

test("startup sync IDLE blocks ready without leaking HEALTHY", () => {
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
  assert.equal(pre.checks.startupSync, "NOT_READY");
  assert.ok(!pre.blockers.includes("STARTUP_SYNC_HEALTHY"));
  assert.ok(pre.blockers.includes("STARTUP_SYNC_NOT_RUN"));
  assert.equal(pre.readyForPaperAutoTrading, false);
});

test("HEALTHY status with boot not verified does NOT put STARTUP_SYNC_HEALTHY in blockers", () => {
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    bootStartupVerified: false,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthOk: true,
    env: PAPER_ENV,
  });
  assert.equal(pre.checks.startupSync, "NOT_READY");
  assert.ok(!pre.blockers.includes("STARTUP_SYNC_HEALTHY"));
  assert.ok(pre.blockers.includes("STARTUP_SYNC_BOOT_NOT_VERIFIED"));
  assert.ok(!pre.blockers.some((b) => /HEALTHY|READY|PASS/.test(b) && !b.includes("NOT_")));
});

test("Credential OK → CREDENTIAL_NOT_READY absent; Auth OK → KIS_AUTH_NOT_READY absent", () => {
  withLock((lockPath) => {
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
    assert.equal(pre.checks.credential, "READY");
    assert.equal(pre.checks.kisAuth, "READY");
    assert.ok(!pre.blockers.includes("CREDENTIAL_NOT_READY"));
    assert.ok(!pre.blockers.includes("KIS_AUTH_NOT_READY"));
  });
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
  withLock((lockPath) => {
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
  });
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
  withLock((lockPath) => {
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
    assert.equal(pre.blockers.length, 0);
    assert.equal(pre.checks.startupSync, "HEALTHY");
  });
});

test("stale/mock quote blocks marketDataReady", () => {
  const state = healthyState();
  for (const q of Object.values(state.quotes)) {
    q.source = "mock";
    q.freshAt = Date.now();
  }
  withLock((lockPath) => {
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
  });
});

test("risk skipped when credential not ready — no confusing RISK_BLOCKED from startup", () => {
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    bootStartupVerified: false,
    credentialOk: false,
    fingerprintOk: false,
    kisAuthOk: false,
    env: PAPER_ENV,
  });
  assert.equal(pre.checks.risk, "SKIPPED");
  assert.ok(pre.blockers.includes("CREDENTIAL_NOT_READY"));
  assert.ok(!pre.blockers.includes("STARTUP_SYNC_HEALTHY"));
});

test("domain error payload structures PAPER_PREFLIGHT_BLOCKED", () => {
  const pre = evaluatePaperTradingPreflight({
    userId: "u1",
    state: healthyState(),
    brokerAccountId: "acct-1",
    bootStartupVerified: false,
    credentialOk: true,
    fingerprintOk: true,
    kisAuthStatus: "RATE_LIMITED",
    env: PAPER_ENV,
    retryAfterMs: 1500,
  });
  const payload = preflightDomainErrorPayload(pre);
  assert.equal(payload.errorCode, "PAPER_PREFLIGHT_BLOCKED");
  assert.equal(payload.readyForPaperAutoTrading, false);
  assert.ok(payload.blockers.some((b) => b.code === "KIS_RATE_LIMITED" && b.retryable));
  assert.ok(!payload.blockers.some((b) => b.code === "STARTUP_SYNC_HEALTHY"));
});

test("instrument metadata resolves 005930 without inventing names", () => {
  const meta = resolveInstrumentMetadata("005930");
  assert.equal(meta.name, "삼성전자");
  assert.equal(formatInstrumentLabel("005930"), "삼성전자 (005930)");
  assert.equal(formatInstrumentLabel("069500"), "KODEX 200 (069500)");
  assert.equal(formatInstrumentLabel("999999"), "999999");
  const before = instrumentNameCacheSizeForTest();
  resolveInstrumentMetadata("005930");
  assert.equal(instrumentNameCacheSizeForTest(), before);
});

test("isKisRateLimitMessage and KisRateLimitError", () => {
  assert.equal(isKisRateLimitMessage("초당 거래건수를 초과하였습니다"), true);
  assert.equal(isKisRateLimitMessage("EGW00201"), true);
  assert.equal(isKisRateLimitMessage("ok"), false);
  const err = new KisRateLimitError("초당 거래건수", 2000);
  assert.equal(err.code, "KIS_RATE_LIMITED");
  assert.equal(err.retryable, true);
  assert.equal(err.retryAfterMs, 2000);
});
