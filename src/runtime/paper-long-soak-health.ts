import type { AppState, Quote } from "@/lib/types";
import { isRegularSession } from "@/lib/market-hours";
import { nowMs } from "@/src/clock";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { hasUnknownOrder, PAPER_OPERATION_DEFAULTS } from "@/src/risk/order-policy";
import { kisHttpAudit } from "@/src/runtime/kis-http-audit";
import { kisJsonPositionDiverged } from "@/src/runtime/controlled-run";
import { holdsWorkerLock, workerLockHealthy } from "@/src/runtime/worker-lock";
import { allowLiveTrading, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { brokerDriver } from "@/src/brokers/kis-config";
import { getRuleConfig } from "@/src/rules/config";
import type { UserRule } from "@/src/rules/params";
import { sma } from "@/src/strategies/indicators";
import { LIVE_KIS_QUOTE_FRESH_MS, isMockOrSeedQuote } from "@/src/runtime/quote-policy";

export const LONG_SOAK_RULE_ID = "paper-long-soak-ma";
export const LONG_SOAK_TICKER = "035720";
export const HEALTH_OBSERVATION_FRESH_MS = 120_000;
export const ORDER_ELIGIBLE_FRESH_MS = LIVE_KIS_QUOTE_FRESH_MS;

export type WorkerRuntimeStatus = "healthy" | "unhealthy" | "unknown";

export function workerRuntimeStatus(
  runtimeWorker: string | null | undefined,
): WorkerRuntimeStatus {
  if (runtimeWorker === "healthy") return "healthy";
  if (runtimeWorker === "unhealthy") return "unhealthy";
  return "unknown";
}

/** Strict worker PASS — undefined/unknown never counts as healthy. */
export function workerRuntimeHealthy(runtimeWorker: string | null | undefined): boolean {
  return workerRuntimeStatus(runtimeWorker) === "healthy";
}

export function workerLockStatusOk(): boolean {
  return holdsWorkerLock() || workerLockHealthy();
}

export function quoteAgeMs(quote: Quote | null | undefined, now = nowMs()): number | null {
  if (!quote?.freshAt) return null;
  return now - quote.freshAt;
}

export function isOrderEligibleFresh(
  quote: Quote | null | undefined,
  now = nowMs(),
  maxAgeMs = ORDER_ELIGIBLE_FRESH_MS,
): boolean {
  if (!quote || quote.source !== "kis") return false;
  if (!quote.freshAt || !(quote.price > 0)) return false;
  return now - quote.freshAt <= maxAgeMs;
}

export function isHealthObservationFresh(
  quote: Quote | null | undefined,
  now = nowMs(),
  maxAgeMs = HEALTH_OBSERVATION_FRESH_MS,
): boolean {
  return isOrderEligibleFresh(quote, now, maxAgeMs);
}

export function mockSeedQuoteCount(quotes: Record<string, Quote> | undefined): {
  mock: number;
  seed: number;
} {
  let mock = 0;
  let seed = 0;
  for (const quote of Object.values(quotes ?? {})) {
    if (quote.source === "mock" || quote.source == null) mock += 1;
    if (quote.source === "seed") seed += 1;
  }
  return { mock, seed };
}

export function enabledAutoRules(rules: UserRule[] = getRuleConfig().rules): UserRule[] {
  return rules.filter((row) => row.enabled && row.ticker);
}

export function unexpectedEnabledRules(
  rules: UserRule[] = getRuleConfig().rules,
): UserRule[] {
  return enabledAutoRules(rules).filter((row) => row.id !== LONG_SOAK_RULE_ID);
}

export function longSoakRule(rules: UserRule[] = getRuleConfig().rules): UserRule | undefined {
  return rules.find((row) => row.id === LONG_SOAK_RULE_ID);
}

export function kodexIntervalRule(rules: UserRule[] = getRuleConfig().rules): UserRule | undefined {
  return rules.find((row) => row.id === "23cd18d6-5dd3-426b-baf1-4e00a2dfeafc" || (row.ticker === "069500" && row.kind === "interval"));
}

export type ActivationGateVerdict = "READY" | "ALREADY_ENABLED" | "BLOCKED";

export function activationGateVerdict(opts: {
  ruleExists: boolean;
  ruleEnabled: boolean;
  prerequisitesOk: boolean;
}): ActivationGateVerdict {
  if (!opts.ruleExists) return "BLOCKED";
  if (opts.ruleEnabled) return "ALREADY_ENABLED";
  return opts.prerequisitesOk ? "READY" : "BLOCKED";
}

export type RuntimeHealthReport = {
  environmentOk: boolean;
  longSoakEnabled: boolean;
  longSoakAllocEnabled: boolean;
  kodexIntervalDisabled: boolean;
  kodexAllocDisabled: boolean;
  otherEnabledAutoRules: string[];
  isolationOk: boolean;
  startupHealthy: boolean;
  workerRuntime: WorkerRuntimeStatus;
  workerRuntimeOk: boolean;
  workerLockOk: boolean;
  reconHealthy: boolean;
  unknownNone: boolean;
  openBuyNone: boolean;
  positionsMatch: boolean;
  orderableOk: boolean;
  balanceOk: boolean;
  rdsOk: boolean;
  mirrorDegraded: boolean;
  mockCount: number;
  seedCount: number;
  quoteSourceKis: boolean;
  healthFresh: boolean;
  orderEligibleFresh: boolean;
  historyReady: boolean;
  marketOpen: boolean;
  realRequests: number;
  price: number | null;
  freshAt: number | null;
  ageMs: number | null;
  fastMa: number | null;
  slowMa: number | null;
  maRel: string | null;
  regime: string | null;
  runtimeHealthReady: boolean;
  orderEligibleNow: boolean;
  reason: string;
};

export function evaluateRuntimeHealth(
  state: AppState,
  opts: {
    runtimeWorker?: string | null;
    env?: EnvMap;
    now?: number;
    includeLockProbe?: boolean;
  } = {},
): RuntimeHealthReport {
  const env = opts.env ?? process.env;
  const now = opts.now ?? nowMs();
  const rules = getRuleConfig().rules;
  const soak = longSoakRule(rules);
  const kodex = kodexIntervalRule(rules);
  const soakAlloc = state.allocations.find((row) => row.ruleId === LONG_SOAK_RULE_ID);
  const kodexAlloc = kodex
    ? state.allocations.find((row) => row.ruleId === kodex.id)
    : undefined;
  const others = unexpectedEnabledRules(rules).map((row) => `${row.id}:${row.ticker}:${row.kind}`);
  const q = state.quotes[LONG_SOAK_TICKER];
  const { mock, seed } = mockSeedQuoteCount(state.quotes);
  const hist = q?.history ?? [];
  const fast = sma(hist, soak?.fastMa ?? 5);
  const slow = sma(hist, soak?.slowMa ?? 20);
  const db = publicDatabaseStatus(env);
  const mirrorDegraded = Boolean(db.lastError?.includes("DB_MIRROR_DEGRADED"));
  const unknown = hasUnknownOrder(state);
  const openBuy = state.orders.some(
    (o) =>
      o.code === LONG_SOAK_TICKER &&
      o.side === "buy" &&
      (o.status === "pending" || o.status === "unknown") &&
      o.activeClass !== "ORPHANED_LOCAL" &&
      o.activeClass !== "HISTORICAL_MATCHED",
  );
  const workerRuntime = workerRuntimeStatus(opts.runtimeWorker);
  const workerRuntimeOk = workerRuntimeHealthy(opts.runtimeWorker);
  const workerLockOk = opts.includeLockProbe === false ? true : workerLockStatusOk();
  const marketOpen = isRegularSession(new Date(now));
  const realRequests = kisHttpAudit().realRequests;
  const environmentOk =
    tradingMode(env) === "live_test" &&
    brokerDriver(env) === "kis" &&
    ["paper", "demo"].includes(String(env.KIS_MODE ?? "").trim().toLowerCase()) &&
    allowLiveTrading(env) === false &&
    env.KIS_LIVE_CONFIRM !== "I_UNDERSTAND";

  const longSoakEnabled = soak?.enabled === true;
  const longSoakAllocEnabled = soakAlloc?.enabled === true;
  const kodexIntervalDisabled = !kodex || kodex.enabled === false;
  const kodexAllocDisabled = !kodexAlloc || kodexAlloc.enabled === false;
  const isolationOk =
    longSoakEnabled &&
    longSoakAllocEnabled &&
    kodexIntervalDisabled &&
    kodexAllocDisabled &&
    others.length === 0;

  const startupHealthy = state.startupSync?.status === "HEALTHY";
  const reconHealthy =
    state.safety?.reconciliation === "synced" ||
    (state.kisBalance?.matched === true && state.kisBalance?.freshness === "fresh");
  // Qty-level JSON↔KIS match only. `matched=false` from inquiry timeout is recon, not position drift.
  const positionsMatch = state.kisBalance != null && !kisJsonPositionDiverged(state);
  const orderableOk = (state.kisBalance?.orderableCash ?? 0) > 0;
  const balanceOk = state.kisBalance != null;
  const rdsOk = db.mode === "mirror" && (db.enabled || db.connected) && !mirrorDegraded;
  const quoteSourceKis = q?.source === "kis";
  const healthFresh = isHealthObservationFresh(q, now);
  const orderEligibleFresh = isOrderEligibleFresh(q, now);
  const historyReady = hist.length >= 20;

  const blockers: string[] = [];
  if (!environmentOk) blockers.push("ENVIRONMENT");
  if (!isolationOk) blockers.push("RULE_ISOLATION");
  if (!startupHealthy) blockers.push("STARTUP_SYNC");
  if (!workerRuntimeOk) blockers.push(`WORKER_RUNTIME_${workerRuntime.toUpperCase()}`);
  if (!workerLockOk) blockers.push("WORKER_LOCK");
  if (!reconHealthy) blockers.push("RECONCILIATION");
  if (unknown) blockers.push("UNKNOWN_ACTIVE");
  if (openBuy) blockers.push("OPEN_BUY");
  if (!positionsMatch) blockers.push("POSITION_MISMATCH");
  if (!balanceOk) blockers.push("BALANCE");
  if (!orderableOk) blockers.push("ORDERABLE");
  if (!rdsOk) blockers.push("RDS");
  if (mirrorDegraded) blockers.push("DB_MIRROR_DEGRADED");
  if (mock > 0 || seed > 0) blockers.push("MOCK_SEED_QUOTE");
  if (!quoteSourceKis) blockers.push("QUOTE_SOURCE");
  // After hours: stale quotes are observation-only (market closed ≠ code failure).
  // Regular session: health observation freshness (<=120s) required for READY.
  if (marketOpen && !healthFresh) blockers.push("QUOTE_STALE_HEALTH");
  if (!historyReady) blockers.push("HISTORY");
  if (realRequests > 0) blockers.push("REAL_REQUESTS");
  if (PAPER_OPERATION_DEFAULTS.maxQtyPerOrder !== 5) blockers.push("MAX_QTY");

  const runtimeHealthReady = blockers.length === 0;
  const orderEligibleNow =
    runtimeHealthReady && marketOpen && orderEligibleFresh && state.settings.autoTrading === true;

  let reason = "OK";
  if (!runtimeHealthReady) reason = blockers.join(",");
  else if (!marketOpen) reason = "MARKET CLOSED";
  else if (!orderEligibleFresh) reason = "QUOTE NOT ORDER-ELIGIBLE (<=15s)";
  else if (!state.settings.autoTrading) reason = "AUTO TRADING OFF";

  return {
    environmentOk,
    longSoakEnabled,
    longSoakAllocEnabled,
    kodexIntervalDisabled,
    kodexAllocDisabled,
    otherEnabledAutoRules: others,
    isolationOk,
    startupHealthy,
    workerRuntime,
    workerRuntimeOk,
    workerLockOk,
    reconHealthy,
    unknownNone: !unknown,
    openBuyNone: !openBuy,
    positionsMatch,
    orderableOk,
    balanceOk,
    rdsOk,
    mirrorDegraded,
    mockCount: mock,
    seedCount: seed,
    quoteSourceKis,
    healthFresh,
    orderEligibleFresh,
    historyReady,
    marketOpen,
    realRequests,
    price: q?.price ?? null,
    freshAt: q?.freshAt ?? null,
    ageMs: quoteAgeMs(q, now),
    fastMa: fast,
    slowMa: slow,
    maRel: soakAlloc?.meta?.maRel != null ? String(soakAlloc.meta.maRel) : null,
    regime: soakAlloc?.meta?.regime != null ? String(soakAlloc.meta.regime) : null,
    runtimeHealthReady,
    orderEligibleNow,
    reason,
  };
}

function yn(ok: boolean): string {
  return ok ? "YES" : "NO";
}

export function formatRuntimeHealthReport(
  report: RuntimeHealthReport,
  extras: {
    broker?: string;
    tradingMode?: string;
    kisMode?: string;
    autoTrading?: boolean;
    historyLen?: number;
  } = {},
): string {
  const lines = [
    "Domestic PAPER Long Soak Runtime Health",
    "=======================================",
    "",
    "Environment",
    "-----------",
    "",
    `BROKER:`,
    extras.broker ?? "kis",
    "",
    `TRADING_MODE:`,
    extras.tradingMode ?? "live_test",
    "",
    `KIS_MODE:`,
    extras.kisMode ?? "paper",
    "",
    `REAL:`,
    "LOCKED",
    "",
    "",
    "Rules",
    "-----",
    "",
    `paper-long-soak-ma:`,
    report.longSoakEnabled ? "ENABLED" : "DISABLED",
    "",
    `035720 Allocation:`,
    report.longSoakAllocEnabled ? "ENABLED" : "DISABLED",
    "",
    `069500 Interval:`,
    report.kodexIntervalDisabled ? "DISABLED" : "ENABLED",
    "",
    `069500 Allocation:`,
    report.kodexAllocDisabled ? "DISABLED" : "ENABLED",
    "",
    `Other Enabled Auto Rules:`,
    report.otherEnabledAutoRules.length === 0 ? "NONE" : report.otherEnabledAutoRules.join(", "),
    "",
    "",
    "Market Data",
    "-----------",
    "",
    `035720 Source:`,
    report.quoteSourceKis ? "KIS" : "NOT_KIS",
    "",
    `Price:`,
    report.price == null ? "—" : String(report.price),
    "",
    `FreshAt:`,
    report.freshAt == null ? "—" : new Date(report.freshAt).toISOString(),
    "",
    `Health Age:`,
    report.ageMs == null ? "—" : `${Math.round(report.ageMs / 1000)}s`,
    "",
    `Health Observation <=120s:`,
    yn(report.healthFresh),
    "",
    `Order Eligible <=15s:`,
    yn(report.orderEligibleFresh),
    "",
    `History:`,
    extras.historyLen != null ? String(extras.historyLen) : report.historyReady ? ">=20" : "<20",
    "",
    `MA5:`,
    report.fastMa == null ? "—" : String(Math.round(report.fastMa)),
    "",
    `MA20:`,
    report.slowMa == null ? "—" : String(Math.round(report.slowMa)),
    "",
    `maRel:`,
    report.maRel ?? "—",
    "",
    `Regime:`,
    report.regime ?? "—",
    "",
    "",
    "Runtime",
    "-------",
    "",
    `Startup Sync:`,
    report.startupHealthy ? "HEALTHY" : "FAIL",
    "",
    `Worker Runtime:`,
    report.workerRuntimeOk ? "HEALTHY" : `FAIL (${report.workerRuntime})`,
    "",
    `Worker Lock:`,
    report.workerLockOk ? "HEALTHY" : "FAIL",
    "",
    `Reconciliation:`,
    report.reconHealthy ? "HEALTHY" : "FAIL",
    "",
    `UNKNOWN_ACTIVE:`,
    report.unknownNone ? "NONE" : "PRESENT",
    "",
    `035720 Open BUY:`,
    report.openBuyNone ? "NONE" : "PRESENT",
    "",
    "",
    "Account",
    "-------",
    "",
    `Orderable Cash:`,
    report.orderableOk ? "OK" : "FAIL",
    "",
    `KIS/JSON Position:`,
    report.positionsMatch ? "MATCH" : "FAIL",
    "",
    "",
    "Database",
    "--------",
    "",
    `Mode:`,
    "mirror",
    "",
    `Connected:`,
    yn(report.rdsOk),
    "",
    `DB_MIRROR_DEGRADED:`,
    report.mirrorDegraded ? "YES" : "NO",
    "",
    "",
    "Quote Safety",
    "------------",
    "",
    `Mock Quotes:`,
    String(report.mockCount),
    "",
    `Seed Quotes:`,
    String(report.seedCount),
    "",
    `Mock Fallback:`,
    "DISABLED",
    "",
    "",
    "HTTP Audit",
    "----------",
    "",
    `REAL Requests:`,
    String(report.realRequests),
    "",
    "",
    "Final",
    "-----",
    "",
    `Long Soak Isolated:`,
    yn(report.isolationOk),
    "",
    `Runtime Health:`,
    report.runtimeHealthReady ? "READY" : "BLOCKED",
    "",
    `Market Session:`,
    report.marketOpen ? "OPEN" : "CLOSED",
    "",
    `Order Eligible Now:`,
    yn(report.orderEligibleNow),
    "",
    `Reason:`,
    report.reason,
  ];
  return lines.join("\n");
}

export function formatActivationGateReport(opts: {
  verdict: ActivationGateVerdict;
  ruleExists: boolean;
  ruleEnabled: boolean;
  prerequisitesOk: boolean;
  details: Record<string, string>;
}): string {
  const activationLabel =
    opts.verdict === "ALREADY_ENABLED"
      ? "NOT APPLICABLE / ALREADY ENABLED"
      : opts.verdict === "READY"
        ? "YES"
        : "NO";
  const lines = [
    "Long Soak Activation Gate (PRE-ACTIVATION ONLY)",
    "===============================================",
    `Rule exists: ${yn(opts.ruleExists)}`,
    `Rule enabled: ${opts.ruleEnabled ? "YES" : "NO"}`,
  ];
  for (const [k, v] of Object.entries(opts.details)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push(`Activation Ready: ${activationLabel}`);
  lines.push(`Activation Verdict: ${opts.verdict}`);
  if (opts.verdict === "ALREADY_ENABLED") {
    lines.push("");
    lines.push("NOTE: Rule is already enabled. Use paper-long-soak-runtime-health.ts for runtime checks.");
    lines.push("This gate is PRE-ACTIVATION ONLY — ALREADY ENABLED is not a failure.");
  } else if (opts.verdict === "READY") {
    lines.push("");
    lines.push("NOTE: Safe to enable in a later step. This script never flips enabled.");
  }
  lines.push("Broker order HTTP POST: 0 (gate does not submit)");
  return lines.join("\n");
}
