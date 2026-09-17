/**
 * Gate 2 VTS test harness. Does not change trading semantics.
 *
 * Layer A: existing unit tests.
 * Layer B: src/runtime/vts-failure-injection.test.ts (FakeKis, no network).
 * Layer C: src/runtime/vts-lifecycle.test.ts (real VTS, default OFF).
 *
 * Opt-in: RUN_KIS_VTS_TESTS / RUN_KIS_VTS_ORDER_TESTS / RUN_KIS_VTS_FLATTEN_TEST.
 * REAL flags abort. Isolated ledger: data/vts-test/<testRunId>/.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configureStateStore, currentStorePath, resetStateStoreForTest } from "@/lib/store";
import type { AppState } from "@/lib/types";
import type { KisApi } from "@/src/brokers/kis-client";
import { loadKisConfig, resolveKisEnvironment, type EnvMap as KisEnv } from "@/src/brokers/kis-config";
import { sessionBlockReason } from "@/src/accounts/execution-policy";
import { checkPaperOrderConstraints, paperMaxQtyPerOrder } from "@/src/risk/order-policy";
import { liveTestCaps, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { safetyOf } from "@/src/runtime/safety";
import { tradingBlocked } from "@/src/risk/circuit";
import {
  configureWorkerLockPath,
  holdsWorkerLock,
  releaseWorkerLock,
} from "@/src/runtime/worker-lock";

export const VTS_TESTS_ENV = "RUN_KIS_VTS_TESTS";
export const VTS_ORDER_TESTS_ENV = "RUN_KIS_VTS_ORDER_TESTS";
export const VTS_FLATTEN_TEST_ENV = "RUN_KIS_VTS_FLATTEN_TEST";

export type VtsRunOutcome = "PASS" | "FAIL" | "BLOCKED" | "INCOMPLETE";

export type VtsTrace = {
  testRunId: string;
  testCaseId: string;
  signalId?: string;
  intentId?: string;
  localOrderId?: string;
  odno?: string;
  fillIds?: string[];
  verification: "UNIT" | "SIMULATED" | "REAL VTS VERIFIED" | "NOT VERIFIED";
};

export type VtsTestRun = {
  testRunId: string;
  dir: string;
  statePath: string;
  lockPath: string;
};

const SECRET_ENV_KEYS = [
  "KIS_PAPER_APP_KEY",
  "KIS_PAPER_APP_SECRET",
  "KIS_PAPER_ACCOUNT_NO",
  "KIS_REAL_APP_KEY",
  "KIS_REAL_APP_SECRET",
  "KIS_REAL_ACCOUNT_NO",
  "KIS_APP_KEY",
  "KIS_APP_SECRET",
  "KIS_LIVE_CONFIRM",
  "KIS_ACCOUNT_NO",
] as const;

export function makeTestRunId(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const short = Math.random().toString(36).slice(2, 8);
  return `VTS-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${short}`;
}

export function redactSecrets(value: string): string {
  let next = value;
  next = next.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  next = next.replace(
    /(authorization)(["']?\s*[:=]\s*["']?)[^"'&\s]+/gi,
    "$1$2[REDACTED]",
  );
  next = next.replace(
    /(appkey|appsecret|app_key|app_secret|access_token|refresh_token|account_password|acctpwd)(["']?\s*[:=]\s*["']?)[^"'&\s]+/gi,
    "$1$2[REDACTED]",
  );
  next = next.replace(/\b\d{8}-?\d{2}\b/g, "[REDACTED_ACCOUNT]");
  return next;
}

export function realTradingFlags(env: EnvMap = process.env): string[] {
  const flags: string[] = [];
  if (String(env.KIS_MODE ?? "").trim().toLowerCase() === "real") flags.push("KIS_MODE");
  if (tradingMode(env) === "live") flags.push("TRADING_MODE");
  if (env.ALLOW_LIVE_TRADING === "true") flags.push("ALLOW_LIVE_TRADING");
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") flags.push("KIS_LIVE_CONFIRM");
  return flags;
}

export function assertVtsSafeEnv(env: EnvMap = process.env): void {
  const flags = realTradingFlags(env);
  if (flags.length === 0) return;
  console.error("VTS TEST ABORTED");
  console.error("REAL trading configuration detected.");
  throw new Error("VTS TEST ABORTED: REAL trading configuration detected.");
}

export function vtsReadTestsEnabled(env: EnvMap = process.env): boolean {
  return env[VTS_TESTS_ENV] === "true" || env[VTS_ORDER_TESTS_ENV] === "true";
}

export function vtsOrderTestsEnabled(env: EnvMap = process.env): boolean {
  return env[VTS_ORDER_TESTS_ENV] === "true";
}

export function vtsFlattenTestEnabled(env: EnvMap = process.env): boolean {
  return env[VTS_FLATTEN_TEST_ENV] === "true";
}

export function vtsOrderEligibility(env: EnvMap & KisEnv = process.env): {
  ok: boolean;
  blocked: string | null;
} {
  const real = realTradingFlags(env);
  if (real.length) {
    return { ok: false, blocked: "REAL trading configuration detected." };
  }
  if (!vtsOrderTestsEnabled(env)) {
    return { ok: false, blocked: `${VTS_ORDER_TESTS_ENV} is not true` };
  }
  if (tradingMode(env) !== "live_test") {
    return { ok: false, blocked: "TRADING_MODE must be live_test" };
  }
  try {
    if (resolveKisEnvironment(env) !== "paper") {
      return { ok: false, blocked: "KIS_MODE must be paper (or demo alias)" };
    }
  } catch {
    return { ok: false, blocked: "KIS_MODE must be paper (or demo alias)" };
  }
  if (env.BROKER !== "kis") {
    return { ok: false, blocked: "BROKER must be kis" };
  }
  const kis = loadKisConfig(env);
  if (kis.environment !== "paper") {
    return { ok: false, blocked: "KIS host is not VTS paper" };
  }
  if (!kis.configured) {
    return { ok: false, blocked: "KIS VTS credentials are not configured" };
  }
  return { ok: true, blocked: null };
}

export function vtsPreflight(state: AppState, env: EnvMap = process.env): {
  ok: boolean;
  blocked: string | null;
  caps: ReturnType<typeof liveTestCaps>;
} {
  const eligibility = vtsOrderEligibility(env);
  const caps = liveTestCaps(env);
  if (!eligibility.ok) return { ok: false, blocked: eligibility.blocked, caps };
  const safety = safetyOf(state);
  if (safety.kind === "store_corrupt") {
    return { ok: false, blocked: "store_corrupt", caps };
  }
  if (safety.kind === "emergency_stop" || !safety.tradingAllowed) {
    return { ok: false, blocked: safety.lastError ?? "trading not allowed", caps };
  }
  const halted = tradingBlocked(state);
  if (halted) return { ok: false, blocked: halted, caps };
  if (safety.reconciliation === "unavailable" || safety.kind === "reconciliation_unavailable") {
    return { ok: false, blocked: "reconciliation unavailable", caps };
  }
  if (safety.reconciliation === "mismatch" || safety.kind === "reconciliation_required") {
    return { ok: false, blocked: "reconciliation mismatch", caps };
  }
  if (!safety.quoteOk || safety.kind === "market_data_unavailable") {
    return { ok: false, blocked: "quote unhealthy", caps };
  }
  if (!safety.brokerConnected || safety.kind === "broker_unavailable") {
    return { ok: false, blocked: "broker unhealthy", caps };
  }
  if (!safety.workerHealthy || safety.kind === "worker_unhealthy") {
    return { ok: false, blocked: "worker unhealthy", caps };
  }
  if (!holdsWorkerLock()) {
    return { ok: false, blocked: "worker lock not held", caps };
  }
  const hours = sessionBlockReason(state);
  if (hours) return { ok: false, blocked: hours, caps };
  const ticker = String(env.VTS_TEST_SYMBOL ?? "005930").trim() || "005930";
  const paper = checkPaperOrderConstraints({
    qty: Math.min(1, paperMaxQtyPerOrder()),
    ticker,
    state,
  });
  if (!paper.ok) return { ok: false, blocked: paper.blocked, caps };
  return { ok: true, blocked: null, caps };
}

export type VtsReadiness = {
  ok: boolean;
  blocked: string | null;
  quoteOk: boolean;
  balanceOk: boolean;
  positionsOk: boolean;
  openOrdersOk: boolean;
  executionsOk: boolean;
};

/** Read-only KIS probes. Never places an order. */
export async function probeVtsReadiness(client: KisApi, ticker = "005930"): Promise<VtsReadiness> {
  const result: VtsReadiness = {
    ok: false,
    blocked: null,
    quoteOk: false,
    balanceOk: false,
    positionsOk: false,
    openOrdersOk: false,
    executionsOk: false,
  };
  try {
    const quote = await client.inquirePrice(ticker);
    result.quoteOk = quote.price > 0;
    if (!result.quoteOk) {
      result.blocked = "ORDER TEST BLOCKED: quote unhealthy";
      return result;
    }
  } catch (err) {
    result.blocked = `ORDER TEST BLOCKED: ${err instanceof Error ? err.message : "quote failed"}`;
    return result;
  }
  try {
    const balance = await client.inquireBalance();
    result.balanceOk = true;
    result.positionsOk = Array.isArray(balance.holdings);
  } catch (err) {
    result.blocked = `ORDER TEST BLOCKED: ${err instanceof Error ? err.message : "balance failed"}`;
    return result;
  }
  let existingOpenBuy = false;
  try {
    const open = await client.inquireOpenOrders();
    result.openOrdersOk = true;
    existingOpenBuy = open.some(
      (row) => row.ticker === ticker && row.side === "buy" && row.unfilledQty > 0,
    );
  } catch (err) {
    result.blocked = `ORDER TEST BLOCKED: ${err instanceof Error ? err.message : "open-order query failed"}`;
    return result;
  }
  try {
    await client.inquireDailyCcld();
    result.executionsOk = true;
  } catch (err) {
    result.blocked = `ORDER TEST BLOCKED: ${err instanceof Error ? err.message : "execution query failed"}`;
    return result;
  }
  if (existingOpenBuy) {
    result.blocked = "ORDER TEST BLOCKED: Existing open BUY order detected";
    return result;
  }
  result.ok =
    result.quoteOk &&
    result.balanceOk &&
    result.positionsOk &&
    result.openOrdersOk &&
    result.executionsOk;
  if (!result.ok) result.blocked = "ORDER TEST BLOCKED";
  return result;
}

export function beginVtsTestRun(
  testCaseId: string,
  opts: { market?: "domestic" | "overseas" } = {},
): VtsTestRun {
  assertVtsSafeEnv();
  const testRunId = makeTestRunId();
  const dir = path.join(process.cwd(), "data", "vts-test", testRunId);
  mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "paper-account.json");
  const lockPath = path.join(dir, "trading-worker.lock");
  configureStateStore(statePath);
  configureWorkerLockPath(lockPath);
  writeFileSync(
    path.join(dir, "metadata.json"),
    `${JSON.stringify(
      {
        testRunId,
        testCaseId,
        market: opts.market ?? "domestic",
        createdAt: new Date().toISOString(),
        statePath: "paper-account.json",
        note: "Do not delete on failure. Crash recovery artifact.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  appendVtsEvent(dir, { type: "run_start", testCaseId, market: opts.market ?? "domestic", store: currentStorePath() });
  return { testRunId, dir, statePath, lockPath };
}

export function finishVtsTestRun(
  run: VtsTestRun,
  outcome: VtsRunOutcome,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    path.join(run.dir, "test-summary.json"),
    `${JSON.stringify(
      {
        testRunId: run.testRunId,
        outcome,
        finishedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  appendVtsEvent(run.dir, { type: "run_end", outcome });
  releaseWorkerLock();
  configureWorkerLockPath(null);
  resetStateStoreForTest();
}

export function appendVtsEvent(dir: string, event: Record<string, unknown>): void {
  const line = redactSecrets(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  appendFileSync(path.join(dir, "events.jsonl"), line, "utf8");
}

export function writeVtsReconciliation(dir: string, value: unknown): void {
  writeFileSync(path.join(dir, "reconciliation.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function envSnapshotWithoutSecrets(env: EnvMap = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "BROKER",
    "TRADING_MODE",
    "KIS_MODE",
    "ALLOW_LIVE_TRADING",
    VTS_TESTS_ENV,
    VTS_ORDER_TESTS_ENV,
    VTS_FLATTEN_TEST_ENV,
    "RUN_KIS_VTS_OVERSEAS_TESTS",
    "RUN_KIS_VTS_OVERSEAS_ORDER_TESTS",
    "VTS_OVERSEAS_TEST_SYMBOL",
    "VTS_OVERSEAS_TEST_EXCHANGE",
  ]) {
    const value = env[key];
    if (value) out[key] = value;
  }
  for (const key of SECRET_ENV_KEYS) {
    if (env[key]) out[key] = "[REDACTED]";
  }
  return out;
}
