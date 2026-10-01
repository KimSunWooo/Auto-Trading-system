/**
 * Account-scoped runtime snapshot — single source for Dashboard/Header/Risk/Worker/Preflight.
 * Never invents cash=0 on inquiry failure; unavailable fields stay null.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { accountDataDir } from "@/src/auth/paper-accounts";
import { tradingBlocked } from "@/src/risk/circuit";
import { isScopeStartupSyncDone } from "@/src/runtime/runtime-scope";
import { workerLockHealthy } from "@/src/runtime/worker-lock";
import { safetyOf } from "@/src/runtime/safety";

export type AccountRuntimeSnapshot = {
  brokerAccountId: string;
  credentialReady: boolean;
  kisAuthReady: boolean;
  startupSyncStatus: "IDLE" | "SYNCING" | "HEALTHY" | "FAILED" | "UNKNOWN";
  bootVerified: boolean;
  reconciled: boolean;
  /** KIS dnca_tot_amt from account ledger snapshot; null = UNAVAILABLE */
  cash: number | null;
  /** KIS ord_psbl_cash; null = UNAVAILABLE */
  orderableCash: number | null;
  holdings: Array<{ ticker: string; name: string; qty: number; avgPrice: number }>;
  openOrders: number;
  unknownActiveOrders: number;
  workerLockHeld: boolean;
  workerHeartbeatAt: number | null;
  workerLockPath: string;
  riskStatus: "READY" | "BLOCKED" | "WARNING";
  riskReason: string | null;
  updatedAt: string;
};

export function accountWorkerLockPath(brokerAccountId: string): string {
  return path.join(accountDataDir(brokerAccountId), "trading-worker.lock");
}

function readHeartbeat(filePath: string): number | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { heartbeatAt?: number };
    return typeof raw.heartbeatAt === "number" ? raw.heartbeatAt : null;
  } catch {
    return null;
  }
}

export function buildAccountRuntimeSnapshot(input: {
  brokerAccountId: string;
  state: AppState;
  /** Explicit credential/auth probes from caller; default infer from state/boot. */
  credentialReady?: boolean;
  kisAuthReady?: boolean;
}): AccountRuntimeSnapshot {
  const { brokerAccountId, state } = input;
  const lockPath = accountWorkerLockPath(brokerAccountId);
  const bootVerified = isScopeStartupSyncDone(brokerAccountId);
  const rawStatus = state.startupSync?.status;
  const startupSyncStatus: AccountRuntimeSnapshot["startupSyncStatus"] = rawStatus
    ? rawStatus
    : "IDLE";
  const safety = safetyOf(state);
  const reconciled = safety.reconciliation === "synced" || state.kisBalance?.matched === true;

  const kis = state.kisBalance;
  const cash = kis && Number.isFinite(kis.cash) ? kis.cash : null;
  const orderableCash =
    kis && kis.orderableCash != null && Number.isFinite(kis.orderableCash)
      ? kis.orderableCash
      : null;
  const holdingsFromKis = (kis?.holdings ?? [])
    .filter((h) => h.qty > 0)
    .map((h) => ({
      ticker: h.ticker,
      name: h.name,
      qty: h.qty,
      avgPrice: h.avgPrice,
    }));

  // Prefer kisBalance holdings; if snapshot missing holdings only, use local positions.
  const holdings =
    holdingsFromKis.length > 0
      ? holdingsFromKis
      : state.positions
          .filter((p) => p.qty > 0)
          .map((p) => ({
            ticker: p.code,
            name: p.name,
            qty: p.qty,
            avgPrice: p.avgPrice,
          }));

  const openOrders = state.orders.filter(
    (o) =>
      !o.parentOrderId &&
      (o.status === "pending" || o.status === "unknown") &&
      o.activeClass !== "ORPHANED_LOCAL" &&
      o.activeClass !== "HISTORICAL_MATCHED",
  ).length;
  const unknownActiveOrders = state.orders.filter(
    (o) =>
      !o.parentOrderId &&
      (o.activeClass === "UNKNOWN_ACTIVE" ||
        (o.status === "unknown" &&
          o.activeClass !== "ORPHANED_LOCAL" &&
          o.activeClass !== "HISTORICAL_MATCHED")),
  ).length;

  const workerLockHeld = workerLockHealthy({ filePath: lockPath });
  const workerHeartbeatAt = readHeartbeat(lockPath);

  const riskReason = tradingBlocked(state, { startupSyncVerified: bootVerified });
  let riskStatus: AccountRuntimeSnapshot["riskStatus"] = "READY";
  if (riskReason) riskStatus = "BLOCKED";
  else if (safety.lastError || state.circuit?.halted) riskStatus = "WARNING";

  const credentialReady =
    input.credentialReady ??
    Boolean(state.kisBalance || state.startupSync?.status === "HEALTHY");
  const kisAuthReady =
    input.kisAuthReady ?? Boolean(state.kisBalance?.syncedAt || bootVerified);

  return {
    brokerAccountId,
    credentialReady,
    kisAuthReady,
    startupSyncStatus,
    bootVerified,
    reconciled,
    cash,
    orderableCash,
    holdings,
    openOrders,
    unknownActiveOrders,
    workerLockHeld,
    workerHeartbeatAt,
    workerLockPath: lockPath,
    riskStatus,
    riskReason,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };
}
