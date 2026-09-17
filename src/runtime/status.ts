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
import { holdsWorkerLock } from "@/src/runtime/worker-lock";
import type { AppState, RuntimePublic } from "@/lib/types";

export function ordersCurrentlyAllowed(state: AppState): boolean {
  if (!state.settings.autoTrading) return false;
  if (!state.settings.disclaimerAccepted) return false;
  if (state.settings.liquidating) return false;
  if (safetyOf(state).kind === "store_corrupt") return false;
  if (safetyOf(state).kind === "emergency_stop") return false;
  return tradingBlocked(state) == null;
}

export function buildRuntimePublic(state: AppState): RuntimePublic {
  const safety = safetyOf(state);
  const clock = getMarketClock();
  const mode = tradingMode();
  const blocked = tradingBlocked(state);
  const broker = getBrokerPublicStatus();
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
  const todayOrders = state.orders.filter(
    (order) =>
      !order.parentOrderId &&
      (order.status === "filled" || order.status === "pending" || order.status === "unknown") &&
      seoulDay(new Date(order.createdAt)) === today,
  ).length;
  const todayExecutions = state.orders.filter(
    (order) =>
      order.parentOrderId &&
      order.status === "filled" &&
      seoulDay(new Date(order.createdAt)) === today,
  ).length;
  const db = publicDatabaseStatus();
  const autoTrading: RuntimePublic["autoTrading"] =
    !state.settings.autoTrading || safety.kind === "emergency_stop" || run?.status === "stopped"
      ? "stopped"
      : !clock.open || run?.status === "paused" || Boolean(blocked)
        ? "paused"
        : "on";
  return {
    tradingMode: mode,
    allowLiveTrading: allowLiveTrading(),
    httpTickAllowed: httpTickAllowed(mode),
    tradingStatus,
    worker: !isLiveLike(mode) || holdsWorkerLock() ? "healthy" : "unhealthy",
    brokerLink:
      broker.driver === "mock" || (broker.configured && safety.brokerConnected)
        ? "connected"
        : "disconnected",
    marketStatus: clock.open ? "open" : "closed",
    risk,
    reconciliation: safety.reconciliation,
    lastTickAt: safety.lastTickAt ?? state.lastEngineAt,
    lastOrderAt: safety.lastOrderAt ?? (lastOrder ? Date.parse(lastOrder.createdAt) : undefined),
    lastError: safety.lastError ?? state.circuit?.lastError,
    lastErrorAt: safety.lastErrorAt ?? state.circuit?.openedAt,
    ordersAllowed: ordersCurrentlyAllowed(state) && !blocked && clock.open,
    autoTrading,
    selectedStrategy: run?.strategyName,
    currentSymbols: run?.symbols,
    soakStatus: run?.status,
    todayOrders,
    todayExecutions,
    realizedPnl: realizedFromOrders(state, run?.startedAt),
    unrealizedPnl: unrealizedFromState(state),
    rdsMirror: db.mode !== "mirror" ? "off" : db.lastError ? "degraded" : db.connected ? "connected" : "off",
  };
}
