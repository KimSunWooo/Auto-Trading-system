/**
 * PAPER auto-trading preflight gate.
 * Separates Worker/process readiness from "autoTradingEnabled=true".
 * Never enables REAL. Never places orders.
 */
import type { AppState, Order } from "@/lib/types";
import { KisClient } from "@/src/brokers/kis-client";
import { loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import {
  maskAccountNumber,
  paperPhysicalAccountFingerprint,
} from "@/src/auth/crypto";
import { loadPaperSecretForAccount } from "@/src/auth/paper-accounts";
import {
  findDefaultPaperAccount,
  PaperAccountSelectionError,
} from "@/src/auth/select-paper-account";
import { findActiveUnknownOrder, usesPaperStartupSync } from "@/src/runtime/startup-sync";
import { isScopeStartupSyncDone, getRuntimeScope } from "@/src/runtime/runtime-scope";
import { workerLockHealthy } from "@/src/runtime/worker-lock";
import { isFreshKisQuote, isMockOrSeedQuote } from "@/src/runtime/quote-policy";
import { tradingBlocked } from "@/src/risk/circuit";
import { hasUnknownOrder } from "@/src/risk/order-policy";
import { allowLiveTrading, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { getMarketClock } from "@/lib/market-hours";
import type { TradingSafetyContext } from "@/src/runtime/trading-safety";

export type PaperTradingPreflight = {
  paperModeConfirmed: boolean;
  realTradingDisabled: boolean;
  credentialReady: boolean;
  kisAuthReady: boolean;
  accountResolved: boolean;
  startupSyncReady: boolean;
  reconciliationHealthy: boolean;
  workerLockReady: boolean;
  marketDataReady: boolean;
  riskReady: boolean;
  idempotencyReady: boolean;
  unknownOrdersClear: boolean;
  readyForPaperAutoTrading: boolean;
  blockers: string[];
  details: {
    brokerAccountId?: string;
    userId?: string;
    environment?: string;
    status?: string;
    accountMasked?: string;
    kisMode?: string;
    startupSyncStatus?: string;
    reconciliation?: string;
    unknownCount?: number;
    openOrdersLocal?: number;
    positionsLocal?: number;
    kisHoldings?: number;
    depositCash?: number | null;
    orderableCash?: number | null;
    workerLockPath?: string;
    marketOpen?: boolean;
    quoteSample?: { ticker: string; fresh: boolean; source?: string };
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

export function evaluatePaperTradingPreflight(input: {
  userId: string;
  state: AppState | null;
  brokerAccountId?: string;
  workerLockPath?: string;
  bootStartupVerified?: boolean;
  env?: EnvMap;
  kisAuthOk?: boolean;
  credentialOk?: boolean;
  fingerprintOk?: boolean;
}): PaperTradingPreflight {
  const env = input.env ?? process.env;
  const blockers: string[] = [];
  const details: PaperTradingPreflight["details"] = {};

  const realBlockers = realAbortTriggers(env);
  const realTradingDisabled = realBlockers.length === 0;
  if (!realTradingDisabled) blockers.push(...realBlockers.map((b) => `REAL_${b}`));

  const mode = String(env.KIS_MODE ?? "").trim().toLowerCase();
  const paperModeConfirmed =
    (mode === "paper" || mode === "demo") &&
    tradingMode(env) === "live_test" &&
    realTradingDisabled;
  if (!paperModeConfirmed) blockers.push("PAPER_MODE_NOT_CONFIRMED");
  details.kisMode = mode || "(unset)";

  const accountResolved = Boolean(input.brokerAccountId);
  if (input.brokerAccountId) details.brokerAccountId = input.brokerAccountId;
  details.userId = input.userId;
  if (!accountResolved) blockers.push("ACCOUNT_NOT_RESOLVED");

  const credentialReady = input.credentialOk === true && input.fingerprintOk !== false;
  if (!credentialReady) blockers.push("CREDENTIAL_NOT_READY");

  const kisAuthReady = input.kisAuthOk === true;
  if (!kisAuthReady) blockers.push("KIS_AUTH_NOT_READY");

  const state = input.state;
  const startupStatus = state?.startupSync?.status ?? "IDLE";
  details.startupSyncStatus = startupStatus;
  const bootOk = input.bootStartupVerified === true;
  const startupSyncReady = usesPaperStartupSync(env)
    ? bootOk && startupStatus === "HEALTHY"
    : false;
  if (!startupSyncReady) {
    blockers.push(
      usesPaperStartupSync(env) ? `STARTUP_SYNC_${startupStatus}` : "STARTUP_SYNC_NOT_APPLICABLE",
    );
  }

  const recon =
    state?.safety?.reconciliation ?? (state?.kisBalance?.matched ? "synced" : "unavailable");
  details.reconciliation = String(recon);
  const reconciliationHealthy = recon === "synced" || state?.kisBalance?.matched === true;
  if (!reconciliationHealthy) blockers.push("RECONCILIATION_NOT_HEALTHY");

  const unknownOrdersClear = state
    ? !hasUnknownOrder(state) && findActiveUnknownOrder(state) == null
    : false;
  details.unknownCount = state ? state.orders.filter((o) => isActiveUnknown(o)).length : 0;
  if (!unknownOrdersClear) blockers.push("UNKNOWN_ORDERS_PRESENT");

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

  const lockPath = input.workerLockPath;
  details.workerLockPath = lockPath;
  const workerLockReady = lockPath ? workerLockHealthy({ filePath: lockPath }) : false;
  if (!workerLockReady) blockers.push("WORKER_LOCK_NOT_HELD");

  const clock = getMarketClock();
  details.marketOpen = clock.open;

  let marketDataReady = false;
  if (state) {
    const entries = Object.values(state.quotes);
    const live = entries.find((q) => !isMockOrSeedQuote(q) && isFreshKisQuote(q));
    if (live) {
      marketDataReady = true;
      details.quoteSample = { ticker: live.code, fresh: true, source: live.source };
    } else {
      const any = entries[0];
      details.quoteSample = any
        ? { ticker: any.code, fresh: isFreshKisQuote(any), source: any.source }
        : undefined;
      blockers.push(entries.length === 0 ? "QUOTE_MISSING" : "QUOTE_STALE_OR_MOCK");
    }
  } else {
    blockers.push("STATE_MISSING");
  }

  const riskBlocked = state
    ? tradingBlocked(state, {
        startupSyncVerified: input.bootStartupVerified === true,
      } satisfies TradingSafetyContext)
    : "state missing";
  const riskReady = riskBlocked == null;
  if (!riskReady) blockers.push(`RISK_BLOCKED:${riskBlocked}`);

  const idempotencyReady = state
    ? (() => {
        const keys = new Map<string, number>();
        for (const intent of state.intents ?? []) {
          keys.set(intent.intentId, (keys.get(intent.intentId) ?? 0) + 1);
        }
        return [...keys.values()].every((n) => n === 1);
      })()
    : false;
  if (!idempotencyReady) blockers.push("IDEMPOTENCY_NOT_READY");

  const uniqueBlockers = [...new Set(blockers)];
  const readyForPaperAutoTrading =
    paperModeConfirmed &&
    realTradingDisabled &&
    credentialReady &&
    kisAuthReady &&
    accountResolved &&
    startupSyncReady &&
    reconciliationHealthy &&
    workerLockReady &&
    marketDataReady &&
    riskReady &&
    idempotencyReady &&
    unknownOrdersClear &&
    uniqueBlockers.length === 0;

  return {
    paperModeConfirmed,
    realTradingDisabled,
    credentialReady,
    kisAuthReady,
    accountResolved,
    startupSyncReady,
    reconciliationHealthy,
    workerLockReady,
    marketDataReady,
    riskReady,
    idempotencyReady,
    unknownOrdersClear,
    readyForPaperAutoTrading,
    blockers: uniqueBlockers,
    details,
  };
}

/**
 * Live PAPER preflight for a user. Does not place orders or flip autoTrading.
 */
export async function runPaperTradingPreflightForUser(input: {
  userId: string;
  state: AppState | null;
  workerLockPath?: string;
  bootStartupVerified?: boolean;
  probeKisAuth?: boolean;
  env?: EnvMap;
}): Promise<PaperTradingPreflight & { account?: { id: string; masked: string } }> {
  const env = input.env ?? process.env;
  const real = realAbortTriggers(env);
  if (real.length) {
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
      bootStartupVerified: false,
    });
    return {
      ...base,
      blockers: [...new Set([...real.map((b) => `REAL_${b}`), ...base.blockers])],
      readyForPaperAutoTrading: false,
    };
  }

  let account;
  try {
    account = await findDefaultPaperAccount(input.userId);
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
    return { ...base, blockers: [...base.blockers, code], readyForPaperAutoTrading: false };
  }
  if (!account) {
    const base = evaluatePaperTradingPreflight({
      userId: input.userId,
      state: input.state,
      env,
      credentialOk: false,
      kisAuthOk: false,
    });
    return {
      ...base,
      blockers: [...base.blockers, "ACCOUNT_NOT_CONNECTED"],
      readyForPaperAutoTrading: false,
    };
  }

  let credentialOk = false;
  let fingerprintOk = false;
  let kisAuthOk = false;
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

      if (input.probeKisAuth && credentialOk) {
        const scope = getRuntimeScope(account.id);
        if (scope?.kisClient instanceof KisClient && scope.kisClient.mode === "paper") {
          await scope.kisClient.ensureToken();
          kisAuthOk = true;
        } else {
          const cfg = loadKisConfig({
            ...env,
            KIS_MODE: "paper",
            KIS_PAPER_ACCOUNT_NO: secret.accountNo,
            KIS_PAPER_APP_KEY: secret.appKey,
            KIS_PAPER_APP_SECRET: secret.appSecret,
            ALLOW_LIVE_TRADING: "false",
          });
          if (cfg.environment !== "paper") throw new Error("not paper");
          const client = new KisClient(cfg);
          await client.ensureToken();
          kisAuthOk = client.mode === "paper";
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "credential/auth failed";
    if (/초당|EGW00201|rate|1분당/i.test(msg)) {
      kisAuthOk = false;
    } else {
      credentialOk = false;
      kisAuthOk = false;
    }
  }

  const boot =
    input.bootStartupVerified ?? (account ? isScopeStartupSyncDone(account.id) : false);

  const result = evaluatePaperTradingPreflight({
    userId: input.userId,
    state: input.state,
    brokerAccountId: account.id,
    workerLockPath: input.workerLockPath,
    bootStartupVerified: boot,
    env,
    credentialOk,
    fingerprintOk,
    kisAuthOk: input.probeKisAuth ? kisAuthOk : credentialOk,
  });

  result.details.environment = account.environment;
  result.details.status = account.status;
  result.details.accountMasked = accountMasked;
  if (!fingerprintOk) result.blockers.push("FINGERPRINT_MISMATCH");

  const blockers = [...new Set(result.blockers)];
  return {
    ...result,
    blockers,
    readyForPaperAutoTrading: result.readyForPaperAutoTrading && fingerprintOk && blockers.length === 0,
    account: { id: account.id, masked: accountMasked },
  };
}

/** Refuse enabling autoTrading unless preflight is fully ready. */
export function assertReadyToEnablePaperAutoTrading(
  preflight: PaperTradingPreflight,
): string | null {
  if (preflight.readyForPaperAutoTrading) return null;
  return `PAPER 자동매매 Preflight 미통과: ${preflight.blockers.join(", ") || "not ready"}`;
}
