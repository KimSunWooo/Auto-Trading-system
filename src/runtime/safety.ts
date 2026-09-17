import { nowIso } from "@/src/clock";
import type { AppState } from "@/lib/types";
import { tradingMode, isLiveLike, type TradingMode } from "@/src/runtime/trading-mode";

export type SafetyKind =
  | "ok"
  | "trading_blocked"
  | "emergency_stop"
  | "reconciliation_required"
  | "reconciliation_unavailable"
  | "market_data_unavailable"
  | "broker_unavailable"
  | "worker_unhealthy"
  | "store_corrupt";

export type ReconciliationStatus = "synced" | "mismatch" | "unavailable" | "pending";

export type SafetyState = {
  kind: SafetyKind;
  tradingAllowed: boolean;
  persistable: boolean;
  workerHealthy: boolean;
  brokerConnected: boolean;
  quoteOk: boolean;
  reconciliation: ReconciliationStatus;
  lastTickAt?: number;
  lastOrderAt?: number;
  lastError?: string;
  lastErrorAt?: string;
  closedByStop: Record<string, string>;
  blockedBuys: string[];
};

export function emptySafety(): SafetyState {
  return {
    kind: "ok",
    tradingAllowed: true,
    persistable: true,
    workerHealthy: true,
    brokerConnected: true,
    quoteOk: true,
    reconciliation: "synced",
    closedByStop: {},
    blockedBuys: [],
  };
}

export function safetyOf(state: Pick<AppState, "safety">): SafetyState {
  const current = state.safety;
  if (!current) return emptySafety();
  return {
    ...emptySafety(),
    ...current,
    closedByStop: current.closedByStop ?? {},
    blockedBuys: current.blockedBuys ?? [],
  };
}

export function stopKey(ruleId: string, ticker: string): string {
  return `${ruleId}:${ticker}`;
}

export function blockSafety(
  state: AppState,
  kind: SafetyKind,
  reason: string,
  extra: Partial<SafetyState> = {},
): AppState {
  const prev = safetyOf(state);
  return {
    ...state,
    safety: {
      ...prev,
      ...extra,
      kind,
      tradingAllowed: false,
      lastError: reason,
      lastErrorAt: nowIso(),
    },
  };
}

export function clearSafetyBlock(state: AppState, extra: Partial<SafetyState> = {}): AppState {
  const prev = safetyOf(state);
  if (prev.kind === "store_corrupt" || prev.kind === "emergency_stop") return state;
  return {
    ...state,
    safety: {
      ...prev,
      ...extra,
      kind: "ok",
      tradingAllowed: true,
      lastError: undefined,
    },
  };
}

export function safetyBlocksTrading(state: AppState, mode: TradingMode = tradingMode()): string | null {
  const safety = safetyOf(state);
  if (safety.kind === "store_corrupt") {
    return safety.lastError ?? "장부 파일이 손상되어 매매를 막았습니다.";
  }
  if (safety.kind === "emergency_stop" || !safety.tradingAllowed) {
    return safety.lastError ?? "안전 상태로 신규 주문을 막았습니다.";
  }
  if (!isLiveLike(mode)) return null;
  if (!safety.quoteOk || safety.kind === "market_data_unavailable") {
    return safety.lastError ?? "시세를 확인하지 못해 신규 주문을 막았습니다.";
  }
  if (!safety.brokerConnected || safety.kind === "broker_unavailable") {
    return safety.lastError ?? "증권사 연결을 확인하지 못해 신규 주문을 막았습니다.";
  }
  if (
    safety.reconciliation === "unavailable" ||
    safety.reconciliation === "mismatch" ||
    safety.kind === "reconciliation_unavailable" ||
    safety.kind === "reconciliation_required"
  ) {
    return safety.lastError ?? "잔고·체결 대조를 끝내지 못해 신규 주문을 막았습니다.";
  }
  if (!safety.workerHealthy || safety.kind === "worker_unhealthy") {
    return safety.lastError ?? "트레이딩 워커가 활성 락을 갖지 못했습니다.";
  }
  return null;
}
