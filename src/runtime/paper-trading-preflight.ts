/**
 * PAPER auto-trading Preflight — single source of truth for CLI and Settings API.
 *
 * Sequential dependency order. Never places orders. Never enables REAL.
 * Blockers contain failure codes only (never HEALTHY / READY / PASS).
 */
import type { AppState, Order } from "@/lib/types";
import type { KisApi } from "@/src/brokers/kis-client";
import {
  KisClient,
  KisRateLimitError,
  isKisRateLimitMessage,
} from "@/src/brokers/kis-client";
import { resolveKisEnvironment } from "@/src/brokers/kis-config";
import {
  maskAccountNumber,
  paperPhysicalAccountFingerprint,
} from "@/src/auth/crypto";
import { loadPaperSecretForAccount } from "@/src/auth/paper-accounts";
import {
  findDefaultPaperAccount,
  PaperAccountSelectionError,
} from "@/src/auth/select-paper-account";
import {
  findActiveUnknownOrder,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";
import {
  isScopeStartupSyncDone,
  getRuntimeScope,
  markScopeStartupSyncDone,
} from "@/src/runtime/runtime-scope";
import { awaitAccountStartupSync } from "@/lib/account-engine-loop";
import { workerLockHealthy } from "@/src/runtime/worker-lock";
import { isFreshKisQuote, isMockOrSeedQuote } from "@/src/runtime/quote-policy";
import { resetCircuit, tradingBlocked } from "@/src/risk/circuit";
import { hasUnknownOrder } from "@/src/risk/order-policy";
import { allowLiveTrading, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { getMarketClock } from "@/lib/market-hours";
import type { TradingSafetyContext } from "@/src/runtime/trading-safety";
import { formatInstrumentLabel, resolveInstrumentMetadata } from "@/src/instruments/metadata";
import { isRecoverableInquiryHalt } from "@/src/runtime/controlled-run";
import {
  evaluateApprovedRdsConfig,
  verifyApprovedRdsLiveCached,
  type RdsAuthorityDenyCode,
} from "@/src/db/rds-authority";
import type { StartTimingTrace } from "@/src/runtime/start-timing";

export type PreflightCheckValue =
  | "READY"
  | "HEALTHY"
  | "PASS"
  | "NOT_READY"
  | "NOT_CHECKED"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "UNAVAILABLE"
  | "FAILED"
  | "SKIPPED";

export type PreflightBlocker = {
  code: string;
  message: string;
  retryable: boolean;
};

/**
 * First failure stage for operator diagnosis (ordered).
 * Past matched=true must never hide a newer failure in a later stage.
 */
export type PreflightFailureStage =
  | "RDS_UNVERIFIED"
  | "KIS_QUERY_FAILED"
  | "RECON_INCOMPLETE"
  | "RECON_MISMATCH"
  | "UNRESOLVED_ORDERS"
  | null;

export type PaperTradingPreflight = {
  paperModeConfirmed: boolean;
  realTradingDisabled: boolean;
  credentialReady: boolean;
  kisAuthReady: boolean;
  accountResolved: boolean;
  rdsAuthorityReady: boolean;
  startupSyncReady: boolean;
  reconciliationHealthy: boolean;
  workerLockReady: boolean;
  marketDataReady: boolean;
  riskReady: boolean;
  idempotencyReady: boolean;
  unknownOrdersClear: boolean;
  readyForPaperAutoTrading: boolean;
  /** Ordered first failure stage — null when ready. */
  firstFailureStage: PreflightFailureStage;
  firstFailureReason?: string;
  /** Failure codes only — never HEALTHY/READY/PASS. */
  blockers: string[];
  blockerDetails: PreflightBlocker[];
  checks: {
    rdsAuthority: PreflightCheckValue;
    paperMode: PreflightCheckValue;
    credential: PreflightCheckValue;
    kisAuth: PreflightCheckValue;
    startupSync: PreflightCheckValue;
    reconciliation: PreflightCheckValue;
    marketData: PreflightCheckValue;
    risk: PreflightCheckValue;
    idempotency: PreflightCheckValue;
    workerLock: PreflightCheckValue;
    unknownOrders: PreflightCheckValue;
  };
  retryAfterMs?: number;
  details: {
    brokerAccountId?: string;
    userId?: string;
    environment?: string;
    status?: string;
    accountMasked?: string;
    kisMode?: string;
    startupSyncStatus?: string;
    reconciliation?: string;
    kisMatched?: boolean;
    kisFreshness?: string;
    unknownCount?: number;
    openOrdersLocal?: number;
    positionsLocal?: number;
    kisHoldings?: number;
    depositCash?: number | null;
    orderableCash?: number | null;
    workerLockPath?: string;
    marketOpen?: boolean;
    rdsHostApproved?: boolean;
    rdsPersistenceMode?: string;
    quoteSample?: { ticker: string; name?: string; fresh: boolean; source?: string };
    /** Soft diagnostic — never blocks PATCH ON by itself. */
    marketDataNote?: string;
  };
};

function realAbortTriggers(env: EnvMap): string[] {
  const blockers: string[] = [];
  if (String(env.ALLOW_LIVE_TRADING ?? "").toLowerCase() === "true") {
    blockers.push("ALLOW_LIVE_TRADING");
  }
  if (String(env.KIS_MODE ?? "").trim().toLowerCase() === "real") {
    blockers.push("KIS_MODE_REAL");
  }
  if (String(env.TRADING_MODE ?? "").trim().toLowerCase() === "live") {
    blockers.push("TRADING_MODE_LIVE");
  }
  if (String(env.KIS_LIVE_CONFIRM ?? "").trim() === "I_UNDERSTAND") {
    blockers.push("KIS_LIVE_CONFIRM");
  }
  if (allowLiveTrading(env)) blockers.push("ALLOW_LIVE_TRADING_RESOLVED");
  try {
    if (resolveKisEnvironment(env) === "real") blockers.push("KIS_ENV_REAL");
  } catch {
    /* load failure handled elsewhere */
  }
  return blockers;
}

function isActiveUnknown(order: Order): boolean {
  if (order.parentOrderId) return false;
  if (order.activeClass === "ORPHANED_LOCAL" || order.activeClass === "HISTORICAL_MATCHED") {
    return false;
  }
  if (order.activeClass === "UNKNOWN_ACTIVE") return true;
  if (order.status === "unknown") return true;
  return false;
}

function isSuccessStatus(value: string): boolean {
  return /^(HEALTHY|READY|PASS|synced|OK|true)$/i.test(value.trim());
}

function pushBlocker(
  blockers: string[],
  details: PreflightBlocker[],
  code: string,
  message: string,
  retryable = false,
) {
  if (!code || isSuccessStatus(code)) return;
  if (code.startsWith("STARTUP_SYNC_") && isSuccessStatus(code.slice("STARTUP_SYNC_".length))) {
    return;
  }
  if (!blockers.includes(code)) blockers.push(code);
  if (!details.some((b) => b.code === code)) {
    details.push({ code, message, retryable });
  }
}

function startupSyncBlockerCode(status: string, bootOk: boolean): string {
  if (status === "FAILED") return "STARTUP_SYNC_FAILED";
  if (status === "SYNCING") return "STARTUP_SYNC_IN_PROGRESS";
  if (status === "IDLE") return "STARTUP_SYNC_NOT_RUN";
  if (status === "HEALTHY" && !bootOk) return "STARTUP_SYNC_BOOT_NOT_VERIFIED";
  return "STARTUP_SYNC_NOT_READY";
}

/**
 * Pure sequential evaluation. Does not call KIS.
 * Callers must pass credential/auth/boot flags from the shared resolve path.
 */
export function evaluatePaperTradingPreflight(input: {
  userId: string;
  state: AppState | null;
  brokerAccountId?: string;
  workerLockPath?: string;
  bootStartupVerified?: boolean;
  env?: EnvMap;
  kisAuthOk?: boolean;
  kisAuthStatus?: PreflightCheckValue;
  credentialOk?: boolean;
  fingerprintOk?: boolean;
  /** Live/config RDS authority — false blocks start. */
  rdsAuthorityOk?: boolean;
  rdsAuthorityStatus?: PreflightCheckValue;
  rdsAuthorityMessage?: string;
  rdsAuthorityCode?: RdsAuthorityDenyCode | string;
  retryAfterMs?: number;
}): PaperTradingPreflight {
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  const blockerDetails: PreflightBlocker[] = [];
  const details: PaperTradingPreflight["details"] = {};
  const checks: PaperTradingPreflight["checks"] = {
    rdsAuthority: "NOT_CHECKED",
    paperMode: "NOT_CHECKED",
    credential: "NOT_CHECKED",
    kisAuth: "NOT_CHECKED",
    startupSync: "NOT_CHECKED",
    reconciliation: "NOT_CHECKED",
    marketData: "NOT_CHECKED",
    risk: "NOT_CHECKED",
    idempotency: "NOT_CHECKED",
    workerLock: "NOT_CHECKED",
    unknownOrders: "NOT_CHECKED",
  };

  // 0. Approved RDS authority — first gate; never substitute local/JSON/mirror.
  const rdsCfg = evaluateApprovedRdsConfig(env);
  details.rdsPersistenceMode = String(env.PERSISTENCE_MODE ?? "(unset)");
  details.rdsHostApproved = rdsCfg.ok;
  const rdsStatus =
    input.rdsAuthorityStatus ??
    (input.rdsAuthorityOk === true
      ? "READY"
      : input.rdsAuthorityOk === false
        ? "NOT_READY"
        : rdsCfg.ok
          ? "NOT_CHECKED"
          : "NOT_READY");
  checks.rdsAuthority = rdsStatus;
  const rdsAuthorityReady = rdsStatus === "READY";
  if (!rdsAuthorityReady) {
    pushBlocker(
      blockers,
      blockerDetails,
      input.rdsAuthorityCode
        ? `RDS_${input.rdsAuthorityCode}`
        : rdsCfg.ok
          ? "RDS_UNVERIFIED"
          : `RDS_${rdsCfg.code}`,
      input.rdsAuthorityMessage ??
        (!rdsCfg.ok ? rdsCfg.message : "승인된 RDS 연결을 확인하지 못했습니다."),
      false,
    );
  }

  // 1. PAPER Runtime
  const realBlockers = realAbortTriggers(env);
  const realTradingDisabled = realBlockers.length === 0;
  if (!realTradingDisabled) {
    for (const b of realBlockers) {
      pushBlocker(blockers, blockerDetails, `REAL_${b}`, `REAL trading abort: ${b}`, false);
    }
  }

  const mode = String(env.KIS_MODE ?? "").trim().toLowerCase();
  const paperModeConfirmed =
    (mode === "paper" || mode === "demo") &&
    tradingMode(env) === "live_test" &&
    realTradingDisabled;
  checks.paperMode = paperModeConfirmed ? "READY" : "NOT_READY";
  if (!paperModeConfirmed) {
    pushBlocker(blockers, blockerDetails, "PAPER_MODE_NOT_CONFIRMED", "PAPER live_test 모드가 아닙니다.", false);
  }
  details.kisMode = mode || "(unset)";

  // 2. BrokerAccount Resolve
  const accountResolved = Boolean(input.brokerAccountId);
  if (input.brokerAccountId) details.brokerAccountId = input.brokerAccountId;
  details.userId = input.userId;
  if (!accountResolved) {
    pushBlocker(blockers, blockerDetails, "ACCOUNT_NOT_RESOLVED", "PAPER 계좌가 선택되지 않았습니다.", false);
  }

  // Early stop: without paper mode / account, remaining checks stay NOT_CHECKED
  // but we still compute what we can from local state without confusing success codes.

  // 3. Credential
  const credentialReady = input.credentialOk === true && input.fingerprintOk !== false;
  checks.credential = credentialReady ? "READY" : "NOT_READY";
  if (!credentialReady) {
    pushBlocker(
      blockers,
      blockerDetails,
      "CREDENTIAL_NOT_READY",
      "BrokerAccount credential decrypt/fingerprint 검증에 실패했습니다.",
      false,
    );
  }

  // 4. KIS Auth
  const kisAuthStatus =
    input.kisAuthStatus ??
    (input.kisAuthOk === true ? "READY" : input.kisAuthOk === false ? "NOT_READY" : "NOT_CHECKED");
  checks.kisAuth = kisAuthStatus;
  const kisAuthReady = kisAuthStatus === "READY";
  if (!kisAuthReady) {
    const retryable = kisAuthStatus === "RATE_LIMITED";
    pushBlocker(
      blockers,
      blockerDetails,
      kisAuthStatus === "RATE_LIMITED" ? "KIS_RATE_LIMITED" : "KIS_AUTH_NOT_READY",
      kisAuthStatus === "RATE_LIMITED"
        ? "KIS 조회 요청 제한에 도달했습니다."
        : "KIS 인증이 준비되지 않았습니다.",
      retryable,
    );
  }

  const state = input.state;

  // 5–7. Startup Sync + Reconciliation + bootVerified (sequential dependency)
  const startupStatus = state?.startupSync?.status ?? "IDLE";
  details.startupSyncStatus = startupStatus;
  const bootOk = input.bootStartupVerified === true;
  const startupSyncReady = usesPaperStartupSync(env)
    ? bootOk && startupStatus === "HEALTHY"
    : false;
  checks.startupSync = startupSyncReady
    ? "HEALTHY"
    : startupStatus === "HEALTHY"
      ? "NOT_READY"
      : startupStatus === "FAILED"
        ? "FAILED"
        : "NOT_READY";
  if (!startupSyncReady) {
    if (!usesPaperStartupSync(env)) {
      pushBlocker(
        blockers,
        blockerDetails,
        "STARTUP_SYNC_NOT_APPLICABLE",
        "PAPER Startup Sync 대상 환경이 아닙니다.",
        false,
      );
    } else {
      const code = startupSyncBlockerCode(startupStatus, bootOk);
      pushBlocker(
        blockers,
        blockerDetails,
        code,
        bootOk
          ? `Startup Sync 상태가 ${startupStatus} 입니다.`
          : "이 서버 프로세스에서 Startup Sync 검증이 아직 완료되지 않았습니다.",
        code === "STARTUP_SYNC_IN_PROGRESS",
      );
    }
  }

  // Reconciliation: safety.reconciliation is authoritative.
  // Stale kisBalance.matched=true must NEVER override a fresh mismatch/unavailable/pending.
  const safetyRecon = state?.safety?.reconciliation;
  const matched = state?.kisBalance?.matched === true;
  const freshness = state?.kisBalance?.freshness;
  details.kisMatched = state?.kisBalance?.matched;
  details.kisFreshness = freshness;
  let reconLabel: string;
  let reconciliationHealthy: boolean;
  if (safetyRecon === "mismatch") {
    reconLabel = "mismatch";
    reconciliationHealthy = false;
  } else if (safetyRecon === "unavailable" || safetyRecon === "pending") {
    reconLabel = safetyRecon;
    reconciliationHealthy = false;
  } else if (safetyRecon === "synced") {
    // Require latest matched agree — do not trust synced alone after a failed refresh.
    reconLabel = matched ? "synced" : "mismatch";
    reconciliationHealthy = matched;
  } else if (matched && freshness === "fresh") {
    reconLabel = "synced";
    reconciliationHealthy = true;
  } else if (matched) {
    // matched without freshness/safety — incomplete, not a pass.
    reconLabel = "unavailable";
    reconciliationHealthy = false;
  } else {
    reconLabel = matched === false ? "mismatch" : "unavailable";
    reconciliationHealthy = false;
  }
  details.reconciliation = reconLabel;
  checks.reconciliation = reconciliationHealthy ? "PASS" : "NOT_READY";
  if (!reconciliationHealthy) {
    const mismatch =
      reconLabel === "mismatch" ||
      state?.kisBalance?.matched === false ||
      safetyRecon === "mismatch";
    pushBlocker(
      blockers,
      blockerDetails,
      mismatch ? "RECONCILIATION_MISMATCH" : "RECONCILIATION_INCOMPLETE",
      mismatch
        ? state?.kisBalance?.message ||
          "로컬 원장과 KIS 잔고·보유가 일치하지 않습니다."
        : "장부 대사가 아직 완료되지 않았습니다.",
      false,
    );
  }

  const unknownOrdersClear = state
    ? !hasUnknownOrder(state) && findActiveUnknownOrder(state) == null
    : false;
  checks.unknownOrders = unknownOrdersClear ? "PASS" : "NOT_READY";
  details.unknownCount = state ? state.orders.filter((o) => isActiveUnknown(o)).length : 0;
  if (!unknownOrdersClear) {
    pushBlocker(
      blockers,
      blockerDetails,
      "UNKNOWN_ORDERS_PRESENT",
      "UNKNOWN 주문이 있어 신규 주문을 차단합니다.",
      false,
    );
  }

  details.openOrdersLocal = state
    ? state.orders.filter(
        (o) =>
          !o.parentOrderId &&
          (o.status === "pending" || o.status === "unknown") &&
          o.activeClass !== "ORPHANED_LOCAL" &&
          o.activeClass !== "HISTORICAL_MATCHED",
      ).length
    : 0;
  details.positionsLocal = state?.positions.filter((p) => p.qty > 0).length ?? 0;
  details.kisHoldings = state?.kisBalance?.holdings?.length ?? 0;
  details.depositCash = state?.kisBalance?.cash ?? null;
  details.orderableCash = state?.kisBalance?.orderableCash ?? null;

  // 8. Market Data — only meaningful after account/startup path
  const clock = getMarketClock();
  details.marketOpen = clock.open;
  let marketDataReady = false;
  if (!state) {
    checks.marketData = "UNAVAILABLE";
    pushBlocker(blockers, blockerDetails, "STATE_MISSING", "거래 상태가 없습니다.", true);
  } else {
    const entries = Object.values(state.quotes);
    const live = entries.find((q) => !isMockOrSeedQuote(q) && isFreshKisQuote(q));
    if (live) {
      marketDataReady = true;
      checks.marketData = "READY";
      const meta = resolveInstrumentMetadata(live.code, live.name);
      details.quoteSample = {
        ticker: live.code,
        name: meta.name ?? undefined,
        fresh: true,
        source: live.source,
      };
    } else {
      checks.marketData = "NOT_READY";
      const any = entries[0];
      if (any) {
        const meta = resolveInstrumentMetadata(any.code, any.name);
        details.quoteSample = {
          ticker: any.code,
          name: meta.name ?? undefined,
          fresh: isFreshKisQuote(any),
          source: any.source,
        };
      }
      // Diagnostic only — off-hours / missing quote samples must not block ON save.
      // Order path still requires a fresh per-ticker KIS quote before submit.
      details.marketDataNote =
        entries.length === 0
          ? "QUOTE_MISSING"
          : "QUOTE_STALE_OR_MOCK";
    }
  }

  // 9. Risk — only after boot/startup evaluated; avoid stacking when earlier gates failed.
  // Start gate: recoverable AppKey/credential hard halt must not block ON when KIS auth is READY
  // (service clears it before evaluate; pure evaluate also ignores that stale halt).
  if (
    credentialReady &&
    kisAuthReady &&
    accountResolved &&
    paperModeConfirmed &&
    rdsAuthorityReady
  ) {
    let riskState = state;
    if (riskState && isRecoverableInquiryHalt(riskState) && kisAuthReady) {
      const cleared = resetCircuit(riskState);
      if (!cleared.error) riskState = cleared.state;
    }
    const riskBlocked = riskState
      ? tradingBlocked(riskState, {
          startupSyncVerified: input.bootStartupVerified === true,
        } satisfies TradingSafetyContext)
      : "state missing";
    const riskReady = riskBlocked == null;
    checks.risk = riskReady ? "PASS" : "NOT_READY";
    if (!riskReady) {
      const msg = String(riskBlocked);
      const rateLimited = isKisRateLimitMessage(msg);
      // Map recon/unknown messages to dedicated codes — avoid opaque RISK_BLOCKED for start.
      if (/잔고|대조|장부|mismatch|정합/i.test(msg) && !rateLimited) {
        pushBlocker(
          blockers,
          blockerDetails,
          "RECONCILIATION_MISMATCH",
          msg,
          false,
        );
      } else if (/미확인|UNKNOWN/i.test(msg) && !rateLimited) {
        pushBlocker(
          blockers,
          blockerDetails,
          "UNKNOWN_ORDERS_PRESENT",
          msg,
          false,
        );
      } else {
        pushBlocker(
          blockers,
          blockerDetails,
          rateLimited ? "KIS_RATE_LIMITED" : "RISK_BLOCKED",
          rateLimited ? "KIS 조회 요청 제한에 도달했습니다." : msg,
          rateLimited,
        );
      }
    }
  } else {
    checks.risk = "SKIPPED";
  }

  // 10. Idempotency
  const idempotencyReady = state
    ? (() => {
        const keys = new Map<string, number>();
        for (const intent of state.intents ?? []) {
          keys.set(intent.intentId, (keys.get(intent.intentId) ?? 0) + 1);
        }
        return [...keys.values()].every((n) => n === 1);
      })()
    : false;
  checks.idempotency = idempotencyReady ? "PASS" : "NOT_READY";
  if (!idempotencyReady) {
    pushBlocker(
      blockers,
      blockerDetails,
      "IDEMPOTENCY_NOT_READY",
      "Intent idempotency 키가 준비되지 않았습니다.",
      false,
    );
  }

  // 11. Worker Lock capability
  const lockPath = input.workerLockPath;
  details.workerLockPath = lockPath;
  const workerLockReady = lockPath ? workerLockHealthy({ filePath: lockPath }) : false;
  checks.workerLock = workerLockReady ? "READY" : "NOT_READY";
  if (!workerLockReady) {
    pushBlocker(
      blockers,
      blockerDetails,
      "WORKER_LOCK_NOT_HELD",
      "거래 Worker Lock이 이 프로세스에서 유효하지 않습니다.",
      true,
    );
  }

  // When risk was SKIPPED due to earlier failure, ready must be false (already blocked).
  const riskGateOk = checks.risk === "PASS";

  const uniqueBlockers = [...new Set(blockers)].filter((b) => !isSuccessStatus(b));
  // marketDataReady is diagnostic for ON save — session/order gates enforce quotes later.
  const readyForPaperAutoTrading =
    rdsAuthorityReady &&
    paperModeConfirmed &&
    realTradingDisabled &&
    credentialReady &&
    kisAuthReady &&
    accountResolved &&
    startupSyncReady &&
    reconciliationHealthy &&
    workerLockReady &&
    riskGateOk &&
    idempotencyReady &&
    unknownOrdersClear &&
    uniqueBlockers.length === 0;

  const { stage: firstFailureStage, reason: firstFailureReason } = classifyFirstFailureStage({
    blockers: uniqueBlockers,
    blockerDetails,
    checks,
    reconciliationLabel: details.reconciliation,
  });

  return {
    paperModeConfirmed,
    realTradingDisabled,
    credentialReady,
    kisAuthReady,
    accountResolved,
    rdsAuthorityReady,
    startupSyncReady,
    reconciliationHealthy,
    workerLockReady,
    marketDataReady,
    riskReady: riskGateOk,
    idempotencyReady,
    unknownOrdersClear,
    readyForPaperAutoTrading,
    firstFailureStage: readyForPaperAutoTrading ? null : firstFailureStage,
    firstFailureReason: readyForPaperAutoTrading ? undefined : firstFailureReason,
    blockers: uniqueBlockers,
    blockerDetails,
    checks,
    retryAfterMs: input.retryAfterMs,
    details,
  };
}

function classifyFirstFailureStage(input: {
  blockers: string[];
  blockerDetails: PreflightBlocker[];
  checks: PaperTradingPreflight["checks"];
  reconciliationLabel?: string;
}): { stage: PreflightFailureStage; reason?: string } {
  const detailOf = (code: string) =>
    input.blockerDetails.find((b) => b.code === code || b.code.startsWith(code))?.message;

  if (
    input.checks.rdsAuthority !== "READY" ||
    input.blockers.some((b) => b.startsWith("RDS_"))
  ) {
    const code = input.blockers.find((b) => b.startsWith("RDS_")) ?? "RDS_UNVERIFIED";
    return { stage: "RDS_UNVERIFIED", reason: detailOf(code) ?? code };
  }

  if (
    input.checks.credential !== "READY" ||
    input.checks.kisAuth !== "READY" ||
    input.blockers.some((b) =>
      /CREDENTIAL|KIS_AUTH|KIS_RATE|FINGERPRINT|ACCOUNT_NOT/.test(b),
    )
  ) {
    const code =
      input.blockers.find((b) =>
        /CREDENTIAL|KIS_AUTH|KIS_RATE|FINGERPRINT|ACCOUNT_NOT/.test(b),
      ) ?? "KIS_QUERY_FAILED";
    return { stage: "KIS_QUERY_FAILED", reason: detailOf(code) ?? code };
  }

  if (input.blockers.includes("UNKNOWN_ORDERS_PRESENT")) {
    return {
      stage: "UNRESOLVED_ORDERS",
      reason: detailOf("UNKNOWN_ORDERS_PRESENT") ?? "미해결 주문",
    };
  }

  if (
    input.blockers.includes("RECONCILIATION_MISMATCH") ||
    input.reconciliationLabel === "mismatch"
  ) {
    return {
      stage: "RECON_MISMATCH",
      reason: detailOf("RECONCILIATION_MISMATCH") ?? "장부 불일치",
    };
  }

  if (
    input.checks.startupSync !== "HEALTHY" ||
    input.checks.reconciliation !== "PASS" ||
    input.blockers.some((b) =>
      /STARTUP_SYNC|RECONCILIATION_INCOMPLETE|RECONCILIATION_NOT/.test(b),
    )
  ) {
    const code =
      input.blockers.find((b) =>
        /STARTUP_SYNC|RECONCILIATION_INCOMPLETE|RECONCILIATION_NOT/.test(b),
      ) ?? "RECON_INCOMPLETE";
    return { stage: "RECON_INCOMPLETE", reason: detailOf(code) ?? code };
  }

  if (input.blockers.length) {
    // Remaining (worker lock / risk / idempotency) — treat incomplete recon path conservatively.
    return {
      stage: "RECON_INCOMPLETE",
      reason: detailOf(input.blockers[0]!) ?? input.blockers[0],
    };
  }

  return { stage: null };
}

type MutateStore = (
  fn: (state: AppState) => AppState | Promise<AppState>,
) => Promise<AppState>;

const preflightInflight = new Map<string, Promise<PaperTradingPreflight & { account?: { id: string; masked: string } }>>();

export function clearPreflightInflightForTest() {
  preflightInflight.clear();
}

async function probeKisAuth(
  client: KisApi,
  opts: { soft?: boolean } = {},
): Promise<{
  status: PreflightCheckValue;
  retryAfterMs?: number;
  error?: string;
  skippedBalance?: boolean;
}> {
  try {
    if (opts.soft && client instanceof KisClient && client.hasCachedAccessToken()) {
      // Soft path for ON start: cached token is enough. Startup Sync will inquire balance.
      return { status: "READY", skippedBalance: true };
    }
    if (client instanceof KisClient && client.hasCachedAccessToken()) {
      await client.inquireBalance();
      return { status: "READY" };
    }
    await client.inquireBalance();
    return { status: "READY" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof KisRateLimitError || isKisRateLimitMessage(msg)) {
      return {
        status: "RATE_LIMITED",
        retryAfterMs: err instanceof KisRateLimitError ? err.retryAfterMs : 1_500,
        error: msg,
      };
    }
    if (/1분당|token|토큰|oauth|EGW00133/i.test(msg)) {
      return { status: "RATE_LIMITED", retryAfterMs: 60_000, error: msg };
    }
    return { status: "AUTH_FAILED", error: msg };
  }
}

async function ensureFreshQuoteSample(
  state: AppState,
  client: KisApi,
  mutateStore?: MutateStore,
): Promise<AppState> {
  const entries = Object.values(state.quotes);
  const live = entries.find((q) => !isMockOrSeedQuote(q) && isFreshKisQuote(q));
  if (live || !mutateStore) return state;

  const tickers = [
    ...new Set([
      ...state.positions.filter((p) => p.qty > 0).map((p) => p.code),
      ...(state.kisBalance?.holdings ?? []).map((h) => h.ticker),
    ]),
  ].slice(0, 1);
  if (tickers.length === 0) tickers.push("005930");

  return mutateStore(async (current) => {
    const quotes = { ...current.quotes };
    for (const ticker of tickers) {
      try {
        const px = await client.inquirePrice(ticker);
        const prev = quotes[ticker];
        const meta = resolveInstrumentMetadata(ticker, prev?.name);
        quotes[ticker] = {
          code: ticker,
          name: meta.name ?? prev?.name ?? ticker,
          market: prev?.market ?? meta.market ?? "KOSPI",
          price: px.price,
          prevClose: px.prevClose ?? px.price,
          open: px.open ?? px.price,
          high: px.high ?? px.price,
          low: px.low ?? px.price,
          volume: px.volume ?? 0,
          bid: px.price,
          ask: px.price,
          history: prev?.history?.length ? [...prev.history.slice(-59), px.price] : [px.price],
          source: "kis",
          transport: "rest",
          freshAt: Date.now(),
        };
      } catch {
        /* quote failure → marketDataReady stays false */
      }
    }
    return { ...current, quotes };
  });
}

/**
 * Shared Preflight service used by CLI and Settings API.
 * When refreshIfNeeded, runs Startup Sync + one quote sample in THIS process.
 */
export async function runPaperTradingPreflightService(input: {
  userId: string;
  state: AppState | null;
  brokerAccountId?: string;
  workerLockPath?: string;
  kisClient?: KisApi;
  mutateStore?: MutateStore;
  getState?: () => Promise<AppState>;
  /** Re-run Startup Sync / quote refresh in this process when needed. */
  refreshIfNeeded?: boolean;
  probeKisAuth?: boolean;
  /** When false (ON start path), skip inquirePrice sample — order gates still require fresh quotes. */
  includeQuoteSample?: boolean;
  /** Prefer cached KIS token without an extra inquireBalance when Startup Sync will run. */
  softKisAuth?: boolean;
  timingTrace?: StartTimingTrace;
  env?: EnvMap;
}): Promise<PaperTradingPreflight & { account?: { id: string; masked: string } }> {
  const flightKey = `${input.userId}:${input.brokerAccountId ?? "default"}`;
  const existing = preflightInflight.get(flightKey);
  if (existing) return existing;

  const run = executePaperTradingPreflightService(input).finally(() => {
    preflightInflight.delete(flightKey);
  });
  preflightInflight.set(flightKey, run);
  return run;
}

async function executePaperTradingPreflightService(input: {
  userId: string;
  state: AppState | null;
  brokerAccountId?: string;
  workerLockPath?: string;
  kisClient?: KisApi;
  mutateStore?: MutateStore;
  getState?: () => Promise<AppState>;
  refreshIfNeeded?: boolean;
  probeKisAuth?: boolean;
  includeQuoteSample?: boolean;
  softKisAuth?: boolean;
  timingTrace?: StartTimingTrace;
  env?: EnvMap;
}): Promise<PaperTradingPreflight & { account?: { id: string; masked: string } }> {
  const env = input.env ?? process.env;
  let retryAfterMs: number | undefined;
  const includeQuoteSample = input.includeQuoteSample !== false;
  const softKisAuth = input.softKisAuth === true;
  const trace = input.timingTrace;

  // 0. Live approved RDS — block auto-trading ON before any KIS/account work.
  const rdsLive = await (trace
    ? trace.measure("rds_ping", () => verifyApprovedRdsLiveCached(env, { budgetMs: 5_000 })).then((r) => r.value)
    : verifyApprovedRdsLiveCached(env, { budgetMs: 5_000 }));
  if (!rdsLive.ok) {
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
      bootStartupVerified: false,
      rdsAuthorityOk: false,
      rdsAuthorityStatus: "FAILED",
      rdsAuthorityCode: rdsLive.code,
      rdsAuthorityMessage: rdsLive.message,
    });
    return {
      ...base,
      readyForPaperAutoTrading: false,
    };
  }

  const real = realAbortTriggers(env);
  if (real.length) {
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
      bootStartupVerified: false,
      rdsAuthorityOk: true,
      rdsAuthorityStatus: "READY",
    });
    return {
      ...base,
      readyForPaperAutoTrading: false,
    };
  }

  let account;
  try {
    if (input.brokerAccountId) {
      const { getDb } = await import("@/src/db/client");
      const schema = await import("@/src/db/schema");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      if (db) {
        const row = (
          await db
            .select()
            .from(schema.brokerAccounts)
            .where(eq(schema.brokerAccounts.id, input.brokerAccountId))
            .limit(1)
        )[0];
        if (row && row.userId === input.userId) account = row;
      }
    }
    if (!account) account = await findDefaultPaperAccount(input.userId);
  } catch (err) {
    const code = err instanceof PaperAccountSelectionError ? err.code : "ACCOUNT_RESOLVE_FAILED";
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
      bootStartupVerified: false,
    });
    pushBlocker(base.blockers, base.blockerDetails, code, "PAPER 계좌 resolve 실패", false);
    return { ...base, readyForPaperAutoTrading: false };
  }

  if (!account) {
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
    });
    pushBlocker(
      base.blockers,
      base.blockerDetails,
      "ACCOUNT_NOT_CONNECTED",
      "연결된 PAPER 계좌가 없습니다.",
      false,
    );
    return { ...base, readyForPaperAutoTrading: false };
  }

  // 3. Credential decrypt (same path as runtime)
  let credentialOk = false;
  let fingerprintOk = false;
  let accountMasked = account.accountNumberMasked ?? "****";
  try {
    const secret = await loadPaperSecretForAccount(account.id);
    if (secret) {
      const fp = paperPhysicalAccountFingerprint(secret.accountNo);
      fingerprintOk = fp === account.physicalAccountFingerprint;
      accountMasked = maskAccountNumber(secret.accountNo);
      const maskOk =
        !account.accountNumberMasked || account.accountNumberMasked === accountMasked;
      credentialOk = Boolean(secret.appKey && secret.appSecret && secret.accountNo) && maskOk;
    }
  } catch {
    credentialOk = false;
    fingerprintOk = false;
  }

  // 4. KIS Auth — reuse scope client / cached token; never invent ensureToken
  let kisAuthStatus: PreflightCheckValue = credentialOk ? "NOT_CHECKED" : "NOT_READY";
  const scope = getRuntimeScope(account.id);
  const client: KisApi | undefined =
    input.kisClient ??
    (scope?.kisClient && (scope.kisClient as KisApi)) ??
    undefined;

  if (input.probeKisAuth !== false && credentialOk && client) {
    const auth = await (trace
      ? trace
          .measure("kis_auth", () => probeKisAuth(client, { soft: softKisAuth }), softKisAuth ? "soft" : "balance")
          .then((r) => r.value)
      : probeKisAuth(client, { soft: softKisAuth }));
    kisAuthStatus = auth.status;
    if (auth.retryAfterMs) retryAfterMs = auth.retryAfterMs;
  } else if (credentialOk && client instanceof KisClient && client.hasCachedAccessToken()) {
    kisAuthStatus = "READY";
  } else if (credentialOk && !client) {
    kisAuthStatus = "UNAVAILABLE";
  }

  let state = input.state;
  let boot = isScopeStartupSyncDone(account.id);

  // 5. Startup Sync — reuse worker in-flight promise; never invent boot from
  // persisted HEALTHY alone or a single balance probe.
  // Force re-run when latest reconciliation is unhealthy even if past HEALTHY/matched.
  if (
    input.refreshIfNeeded &&
    credentialOk &&
    (kisAuthStatus === "READY" || kisAuthStatus === "NOT_CHECKED") &&
    client &&
    input.mutateStore &&
    usesPaperStartupSync(env)
  ) {
    const safetyRecon = state?.safety?.reconciliation;
    const reconUnhealthy =
      safetyRecon === "mismatch" ||
      safetyRecon === "unavailable" ||
      safetyRecon === "pending" ||
      state?.kisBalance?.matched === false ||
      state?.kisBalance?.freshness === "unknown" ||
      (state?.kisBalance?.matched === true && safetyRecon === "mismatch");
    const needsSync =
      !boot ||
      !state?.startupSync ||
      state.startupSync.status !== "HEALTHY" ||
      reconUnhealthy;
    if (needsSync) {
      try {
        // Only invalidate boot when ledger is unhealthy or sync never completed.
        // Do not clear a healthy boot — that forces a redundant multi-minute sync.
        if (
          reconUnhealthy ||
          !state?.startupSync ||
          state.startupSync.status !== "HEALTHY"
        ) {
          markScopeStartupSyncDone(account.id, false);
        }
        const syncFn = async () => {
          boot = await awaitAccountStartupSync(
            account.id,
            { mutateStore: input.mutateStore! },
            client,
          );
          if (input.getState) {
            state = await input.getState();
          } else {
            state = await input.mutateStore!(async (current) => current);
          }
          boot = isScopeStartupSyncDone(account.id);
        };
        if (trace) await trace.measure("startup_sync", syncFn, reconUnhealthy ? "force-recon" : "boot");
        else await syncFn();

        // Clear stale AppKey/credential hard halt after successful auth + sync path.
        if (
          state &&
          kisAuthStatus === "READY" &&
          isRecoverableInquiryHalt(state) &&
          input.mutateStore
        ) {
          state = await input.mutateStore((current) => {
            if (!isRecoverableInquiryHalt(current)) return current;
            const reset = resetCircuit(current);
            return reset.error ? current : reset.state;
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isKisRateLimitMessage(msg) || err instanceof KisRateLimitError) {
          kisAuthStatus = "RATE_LIMITED";
          retryAfterMs =
            err instanceof KisRateLimitError ? err.retryAfterMs : retryAfterMs ?? 1_500;
        }
      }
    } else if (
      state &&
      kisAuthStatus === "READY" &&
      isRecoverableInquiryHalt(state) &&
      input.mutateStore
    ) {
      // HEALTHY recon path still clears stale credential halt so ON is not blocked.
      state = await input.mutateStore((current) => {
        if (!isRecoverableInquiryHalt(current)) return current;
        const reset = resetCircuit(current);
        return reset.error ? current : reset.state;
      });
    }

    // Quote sample is diagnostic only — never required for ON save (order path enforces quotes).
    if (
      includeQuoteSample &&
      state &&
      boot &&
      state.startupSync?.status === "HEALTHY"
    ) {
      try {
        const quoteFn = async () => {
          state = await ensureFreshQuoteSample(state!, client, input.mutateStore);
        };
        if (trace) await trace.measure("quote_sample", quoteFn);
        else await quoteFn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isKisRateLimitMessage(msg)) {
          retryAfterMs = 1_500;
        }
      }
    }
  }

  const result = evaluatePaperTradingPreflight({
    userId: input.userId,
    state,
    brokerAccountId: account.id,
    workerLockPath: input.workerLockPath,
    bootStartupVerified: boot,
    env,
    credentialOk,
    fingerprintOk,
    kisAuthOk: kisAuthStatus === "READY",
    kisAuthStatus,
    rdsAuthorityOk: true,
    rdsAuthorityStatus: "READY",
    retryAfterMs,
  });

  result.details.environment = account.environment;
  result.details.status = account.status;
  result.details.accountMasked = accountMasked;
  if (!fingerprintOk && credentialOk === false) {
    /* already CREDENTIAL_NOT_READY */
  } else if (!fingerprintOk) {
    pushBlocker(
      result.blockers,
      result.blockerDetails,
      "FINGERPRINT_MISMATCH",
      "물리 계좌 fingerprint가 일치하지 않습니다.",
      false,
    );
  }

  const blockers = [...new Set(result.blockers)].filter((b) => !isSuccessStatus(b));
  return {
    ...result,
    blockers,
    readyForPaperAutoTrading:
      result.readyForPaperAutoTrading && fingerprintOk && blockers.length === 0,
    account: { id: account.id, masked: accountMasked },
  };
}

/** @deprecated Prefer runPaperTradingPreflightService — kept for call-site compatibility. */
export async function runPaperTradingPreflightForUser(input: {
  userId: string;
  state: AppState | null;
  workerLockPath?: string;
  bootStartupVerified?: boolean;
  probeKisAuth?: boolean;
  env?: EnvMap;
  brokerAccountId?: string;
  kisClient?: KisApi;
  mutateStore?: MutateStore;
  /** Optional fresh read after shared Startup Sync (preferred over identity mutate). */
  getState?: () => Promise<AppState>;
  refreshIfNeeded?: boolean;
  includeQuoteSample?: boolean;
  softKisAuth?: boolean;
}): Promise<PaperTradingPreflight & { account?: { id: string; masked: string } }> {
  return runPaperTradingPreflightService({
    userId: input.userId,
    state: input.state,
    workerLockPath: input.workerLockPath,
    probeKisAuth: input.probeKisAuth,
    env: input.env,
    brokerAccountId: input.brokerAccountId,
    kisClient: input.kisClient,
    mutateStore: input.mutateStore,
    refreshIfNeeded: input.refreshIfNeeded,
    includeQuoteSample: input.includeQuoteSample,
    softKisAuth: input.softKisAuth,
  });
}

export function assertReadyToEnablePaperAutoTrading(
  preflight: PaperTradingPreflight,
): string | null {
  if (preflight.readyForPaperAutoTrading) return null;
  return `PAPER 자동매매 Preflight 미통과: ${preflight.blockers.join(", ") || "not ready"}`;
}

export function preflightDomainErrorPayload(preflight: PaperTradingPreflight) {
  return {
    errorCode: "PAPER_PREFLIGHT_BLOCKED",
    message: "PAPER 자동매매 시작 조건을 충족하지 못했습니다.",
    error: assertReadyToEnablePaperAutoTrading(preflight) ?? "not ready",
    firstFailureStage: preflight.firstFailureStage,
    firstFailureReason: preflight.firstFailureReason,
    blockers: preflight.blockerDetails.length
      ? preflight.blockerDetails
      : preflight.blockers.map((code) => ({
          code,
          message: code,
          retryable: code === "KIS_RATE_LIMITED" || code.includes("RATE"),
        })),
    checks: preflight.checks,
    retryAfterMs: preflight.retryAfterMs,
    readyForPaperAutoTrading: false,
  };
}

export { formatInstrumentLabel };
