import { getMarketClock } from "@/lib/market-hours";
import { getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { seoulDay } from "@/src/risk/limits";
import { tradingBlocked } from "@/src/risk/circuit";
import { safetyOf } from "@/src/runtime/safety";
import {
  realizedFromOrders,
  unrealizedFromState,
} from "@/src/runtime/controlled-run";
import {
  allowLiveTrading,
  httpTickAllowed,
  isLiveLike,
  tradingMode,
} from "@/src/runtime/trading-mode";
import { workerLockHealthy } from "@/src/runtime/worker-lock";
import {
  accountWorkerLockPath,
  buildAccountRuntimeSnapshot,
} from "@/src/runtime/account-runtime-snapshot";
import { isScopeStartupSyncDone } from "@/src/runtime/runtime-scope";
import type { AppState, RuntimePublic } from "@/lib/types";

export function ordersCurrentlyAllowed(state: AppState, bootVerified?: boolean): boolean {
  if (!state.settings.autoTrading) return false;
  if (!state.settings.disclaimerAccepted) return false;
  if (state.settings.liquidating) return false;
  if (safetyOf(state).kind === "store_corrupt") return false;
  if (safetyOf(state).kind === "emergency_stop") return false;
  return (
    tradingBlocked(state, {
      startupSyncVerified: bootVerified,
    }) == null
  );
}

export function buildRuntimePublic(
  state: AppState,
  opts: {
    broker?: ReturnType<typeof getBrokerPublicStatus>;
    /** Account-scoped lock + boot verification (PAPER per-account workers). */
    brokerAccountId?: string;
  } = {},
): RuntimePublic {
  const safety = safetyOf(state);
  const clock = getMarketClock();
  const mode = tradingMode();
  const brokerAccountId = opts.brokerAccountId;
  const bootVerified = brokerAccountId
    ? isScopeStartupSyncDone(brokerAccountId)
    : undefined;
  const lockPath = brokerAccountId ? accountWorkerLockPath(brokerAccountId) : undefined;
  const blocked = tradingBlocked(state, {
    startupSyncVerified: bootVerified,
  });
  // Prefer caller-supplied account-scoped status; bootstrap falls back to env.
  const broker = opts.broker ?? getBrokerPublicStatus();
  const tradingStatus: RuntimePublic["tradingStatus"] =
    safety.kind === "emergency_stop" || !state.settings.autoTrading
      ? "stopped"
      : blocked
        ? "blocked"
        : "running";
  const risk: RuntimePublic["risk"] = blocked
    ? "blocked"
    : safety.lastError || state.circuit?.halted
      ? "warning"
      : "normal";
  const lastOrder = state.orders.find((row) => !row.parentOrderId);
  const run = state.controlledRun;
  const today = seoulDay();
  // Include HISTORICAL_MATCHED KIS backfills in order/fill badges (not only Seoul today).
  const parentOrders = state.orders.filter((order) => !order.parentOrderId);
  const todayOrders = parentOrders.filter(
    (order) =>
      (order.status === "filled" || order.status === "pending" || order.status === "unknown") &&
      (order.provenance === "KIS_PAPER_HISTORY" ||
        seoulDay(new Date(order.createdAt)) === today),
  ).length;
  const todayExecutions = state.orders.filter(
    (order) =>
      (order.parentOrderId &&
        order.status === "filled" &&
        seoulDay(new Date(order.createdAt)) === today) ||
      (!order.parentOrderId &&
        order.status === "filled" &&
        order.provenance === "KIS_PAPER_HISTORY" &&
        (order.filledQty ?? order.qty) > 0),
  ).length;
  const db = publicDatabaseStatus();
  const autoTrading: RuntimePublic["autoTrading"] =
    !state.settings.autoTrading || safety.kind === "emergency_stop" || run?.status === "stopped"
      ? "stopped"
      : !clock.open || run?.status === "paused" || Boolean(blocked)
        ? "paused"
        : "on";

  const workerHealthy =
    !isLiveLike(mode) ||
    workerLockHealthy(lockPath ? { filePath: lockPath } : undefined);

  const accountSnapshot = brokerAccountId
    ? buildAccountRuntimeSnapshot({ brokerAccountId, state })
    : undefined;

  return {
    tradingMode: mode,
    allowLiveTrading: allowLiveTrading(),
    httpTickAllowed: httpTickAllowed(mode),
    tradingStatus,
    worker: workerHealthy ? "healthy" : "unhealthy",
    brokerLink: broker.configured && safety.brokerConnected ? "connected" : "disconnected",
    marketStatus: clock.open ? "open" : "closed",
    risk: accountSnapshot
      ? accountSnapshot.riskStatus === "READY"
        ? "normal"
        : accountSnapshot.riskStatus === "WARNING"
          ? "warning"
          : "blocked"
      : risk,
    reconciliation: safety.reconciliation,
    lastTickAt: safety.lastTickAt ?? state.lastEngineAt,
    lastOrderAt: safety.lastOrderAt ?? (lastOrder ? Date.parse(lastOrder.createdAt) : undefined),
    lastError: safety.lastError ?? state.circuit?.lastError,
    lastErrorAt: safety.lastErrorAt ?? state.circuit?.openedAt,
    ordersAllowed: ordersCurrentlyAllowed(state, bootVerified) && !blocked && clock.open,
    autoTrading,
    selectedStrategy: run?.strategyName,
    currentSymbols: run?.symbols,
    soakStatus: run?.status,
    todayOrders,
    todayExecutions,
    realizedPnl: realizedFromOrders(state, run?.startedAt),
    unrealizedPnl: unrealizedFromState(state),
    rdsMirror:
      db.mode === "json"
        ? "off"
        : db.lastError
          ? "degraded"
          : db.enabled || db.connected
            ? "connected"
            : "off",
    accountSnapshot: accountSnapshot
      ? {
          brokerAccountId: accountSnapshot.brokerAccountId,
          credentialReady: accountSnapshot.credentialReady,
          kisAuthReady: accountSnapshot.kisAuthReady,
          startupSyncStatus: accountSnapshot.startupSyncStatus,
          bootVerified: accountSnapshot.bootVerified,
          reconciled: accountSnapshot.reconciled,
          cash: accountSnapshot.cash,
          orderableCash: accountSnapshot.orderableCash,
          holdings: accountSnapshot.holdings,
          openOrders: accountSnapshot.openOrders,
          unknownActiveOrders: accountSnapshot.unknownActiveOrders,
          workerLockHeld: accountSnapshot.workerLockHeld,
          workerHeartbeatAt: accountSnapshot.workerHeartbeatAt,
          riskStatus: accountSnapshot.riskStatus,
          updatedAt: accountSnapshot.updatedAt,
        }
      : undefined,
  };
}
