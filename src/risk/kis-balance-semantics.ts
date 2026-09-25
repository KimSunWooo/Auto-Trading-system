import type { AppState, KisBalanceSnapshot, Order } from "@/lib/types";
import { resolveKisEnvironment, type EnvMap } from "@/src/brokers/kis-config";
import type { KisAccountBalance, KisPsblOrder } from "@/src/brokers/kis-client";

/**
 * PAPER/VTS only. Explicit KIS_MODE=paper|demo.
 * Empty KIS_MODE and REAL flags never select this path.
 */
export function usesPaperBrokerBalanceSemantics(env: EnvMap = process.env): boolean {
  const raw = String(env.KIS_MODE ?? "").trim().toLowerCase();
  if (raw !== "paper" && raw !== "demo") return false;
  if (String(env.TRADING_MODE ?? "").trim().toLowerCase() === "live") return false;
  if (env.ALLOW_LIVE_TRADING === "true") return false;
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") return false;
  try {
    return resolveKisEnvironment(env) === "paper";
  } catch {
    return false;
  }
}

export function latestOrderActivityMs(state: AppState): number {
  let latest = 0;
  for (const order of state.orders) {
    const ms = new Date(order.createdAt).getTime();
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  return latest;
}

export function snapshotFetchedAtMs(snap: KisBalanceSnapshot | undefined): number {
  if (!snap) return NaN;
  const raw = snap.fetchedAt ?? snap.syncedAt;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function isBrokerSnapshotStale(state: AppState, snap: KisBalanceSnapshot | undefined): boolean {
  if (!snap?.syncedAt && !snap?.fetchedAt) return true;
  if (snap.freshness === "stale" || snap.freshness === "unknown") return true;
  const synced = snapshotFetchedAtMs(snap);
  if (!Number.isFinite(synced)) return true;
  const activity = latestOrderActivityMs(state);
  return activity > synced;
}

export function brokerSnapshotFreshness(
  state: AppState,
  snap: KisBalanceSnapshot | undefined,
): "fresh" | "stale" | "unknown" {
  if (!snap) return "unknown";
  if (snap.freshness === "unknown") return "unknown";
  if (isBrokerSnapshotStale(state, snap)) return "stale";
  return snap.freshness ?? "fresh";
}

export function mergePsblIntoSnapshot(
  snap: KisBalanceSnapshot,
  psbl: KisPsblOrder | undefined,
): KisBalanceSnapshot {
  if (!psbl) return snap;
  return {
    ...snap,
    orderableCash: psbl.orderableCash,
    nrcvbBuyAmt: psbl.nrcvbBuyAmt,
  };
}

export function snapshotFromBrokerBalance(
  remote: KisAccountBalance,
  diff: { cashDelta: number; matched: boolean; message: string },
  now = Date.now(),
  psbl?: KisPsblOrder,
): KisBalanceSnapshot {
  const iso = new Date(now).toISOString();
  return mergePsblIntoSnapshot(
    {
      syncedAt: iso,
      fetchedAt: iso,
      cash: remote.cash,
      d2Cash: remote.d2Cash,
      thdtBuyAmt: remote.thdtBuyAmt,
      thdtTlexAmt: remote.thdtTlexAmt,
      nxdyExccAmt: remote.nxdyExccAmt,
      holdings: remote.holdings,
      cashDelta: diff.cashDelta,
      matched: diff.matched,
      freshness: "fresh",
      message: diff.message,
    },
    psbl,
  );
}

export type CashSnapshotInput = {
  currency: string;
  cashBalance: number;
  orderableAmount: number;
  source?: string;
};

/**
 * KRW cash_balance ← broker deposit cash (`dnca_tot_amt`).
 * KRW orderable_amount ← broker orderable cash (`ord_psbl_cash`).
 * Never maps D+2 `prvs_rcdl_excc_amt` as orderable cash.
 */
export function domesticCashRowsFromState(state: AppState): CashSnapshotInput[] {
  const snap = state.kisBalance;
  if (!snap) {
    return [
      {
        currency: "KRW",
        cashBalance: state.cash,
        orderableAmount: state.cash,
        source: "LOCAL_STATE",
      },
    ];
  }
  if (snap.orderableCash == null) return [];
  return [
    {
      currency: "KRW",
      cashBalance: snap.cash,
      orderableAmount: snap.orderableCash,
      source: "KIS_BALANCE",
    },
  ];
}

export type ReconProjection = {
  triggerType: string;
  status: "HEALTHY" | "MISMATCH" | "UNKNOWN";
  items: Array<{
    itemType: string;
    status: string;
    message?: string | null;
    localReference?: string | null;
    brokerReference?: string | null;
    instrumentId?: string | null;
    localValueJson?: unknown;
    brokerValueJson?: unknown;
  }>;
};

export function reconProjectionFromState(state: AppState, env: EnvMap = process.env): ReconProjection | null {
  const snap = state.kisBalance;
  if (!snap) return null;
  const freshness = brokerSnapshotFreshness(state, snap);
  const brokerValue = {
    brokerDepositCash: snap.cash,
    brokerOrderableCash: snap.orderableCash,
    thdtBuyAmt: snap.thdtBuyAmt,
    freshness,
  };
  const localValue = { localLedgerCash: state.cash, positions: state.positions };

  if (freshness !== "fresh") {
    return {
      triggerType: "SCHEDULED",
      status: "UNKNOWN",
      items: [
        {
          itemType: "BALANCE",
          status: "UNKNOWN",
          message:
            freshness === "stale"
              ? "Broker snapshot is stale; not reusing a pre-order HEALTHY run."
              : snap.message || "Broker balance inquiry failed.",
          localValueJson: localValue,
          brokerValueJson: brokerValue,
        },
      ],
    };
  }

  if (!snap.matched) {
    const cashLine = /예수금/.test(snap.message);
    return {
      triggerType: "SCHEDULED",
      status: "MISMATCH",
      items: [
        {
          itemType: cashLine ? "BALANCE" : "POSITION",
          status: "MISMATCH",
          message: snap.message || "POSITION MISMATCH",
          localValueJson: localValue,
          brokerValueJson: { ...brokerValue, holdings: snap.holdings },
        },
      ],
    };
  }

  const paper = usesPaperBrokerBalanceSemantics(env);
  return {
    triggerType: "SCHEDULED",
    status: "HEALTHY",
    items: [
      { itemType: "POSITION", status: "MATCH", message: "POSITION MATCH" },
      { itemType: "ORDER", status: "MATCH", message: "ORDER MATCH" },
      { itemType: "EXECUTION", status: "MATCH", message: "EXECUTION MATCH" },
      {
        itemType: "BALANCE",
        status: "MATCH",
        message: paper
          ? "PAPER: local ledger cash is not compared to broker deposit cash (dnca_tot_amt)."
          : "BALANCE MATCH",
        localValueJson: localValue,
        brokerValueJson: brokerValue,
      },
    ],
  };
}

/** Do not insert HEALTHY from a snapshot that was not a new broker read. */
export function shouldSkipReconPersist(
  last: { status: string; finishedAt?: string | null; startedAt: string } | undefined,
  recon: { status: string },
  snapshotSyncedAt?: string,
): boolean {
  if (!last) return false;
  if (last.status !== recon.status) return false;
  if (recon.status === "HEALTHY") {
    if (!snapshotSyncedAt) return true;
    const lastMs = new Date(last.finishedAt ?? last.startedAt).getTime();
    const snapMs = new Date(snapshotSyncedAt).getTime();
    if (!Number.isFinite(snapMs)) return true;
    return Number.isFinite(lastMs) && lastMs >= snapMs;
  }
  const lastMs = new Date(last.finishedAt ?? last.startedAt).getTime();
  const snapMs = snapshotSyncedAt ? new Date(snapshotSyncedAt).getTime() : NaN;
  if (Number.isFinite(snapMs) && Number.isFinite(lastMs) && snapMs > lastMs) return false;
  return true;
}

export function engineReconciliationFlag(
  state: AppState,
): "synced" | "mismatch" | "unavailable" {
  const freshness = brokerSnapshotFreshness(state, state.kisBalance);
  if (freshness !== "fresh") return "unavailable";
  if (state.kisBalance?.matched === false) return "mismatch";
  return "synced";
}

export function intentStatusFromOrder(order: Order | undefined, runtimeStatus: string): string {
  if (!order) {
    const status = runtimeStatus.toUpperCase();
    if (status === "SUBMITTED") return "SUBMITTED";
    if (status === "FILLED") return "FILLED";
    if (status === "REJECTED") return "REJECTED";
    if (status === "UNKNOWN") return "UNKNOWN";
    if (status === "CANCELLED") return "CANCELLED";
    return "PENDING";
  }
  if (order.status === "filled") return "FILLED";
  if (order.status === "rejected") return "REJECTED";
  if (order.status === "unknown") return "UNKNOWN";
  if (order.status === "cancelled") return "CANCELLED";
  if (order.status === "pending" && order.brokerOrderNo) return "SUBMITTED";
  return "PENDING";
}
