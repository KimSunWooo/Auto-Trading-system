import { getMarketClock } from "@/lib/market-hours";
import { getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { tradingBlocked } from "@/src/risk/circuit";
import { safetyOf } from "@/src/runtime/safety";
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
  };
}
