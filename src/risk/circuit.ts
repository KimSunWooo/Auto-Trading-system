import type { AppState, CircuitKind, CircuitState, Order } from "@/lib/types";

import { safetyBlocksTrading } from "@/src/runtime/safety";
import {
  findActiveUnknownOrder,
  isActiveUnknownBlocker,
  startupSyncBlocksTrading,
} from "@/src/runtime/startup-sync";
import type { TradingSafetyContext } from "@/src/runtime/trading-safety";

export function emptyCircuit(): CircuitState {
  return { halted: false, unknownCount: 0 };
}

export function hasOpenRisk(state: AppState): boolean {
  return (
    Boolean(state.circuit?.halted) ||
    state.orders.some(
      (order) =>
        !order.parentOrderId &&
        (isActiveUnknownBlocker(order) ||
          (order.status === "pending" &&
            Boolean(order.brokerOrderNo) &&
            order.activeClass !== "ORPHANED_LOCAL")),
    )
  );
}

export function tradingBlocked(
  state: AppState,
  safety?: TradingSafetyContext,
): string | null {
  const safetyBlock = safetyBlocksTrading(state);
  if (safetyBlock) return safetyBlock;
  const startup = startupSyncBlocksTrading(state, process.env, {
    bootVerified: safety?.startupSyncVerified,
  });
  if (startup) return startup;
  if (state.circuit?.halted) {
    return state.circuit.reason ?? "서킷 브레이커가 열려 주문을 차단했습니다.";
  }
  const unknown = findActiveUnknownOrder(state);
  if (unknown) {
    return (
      unknown.reason ??
      `현재 PAPER 미확인 주문(${unknown.name} ${unknown.qty}주)이 있어 신규 주문을 막습니다.`
    );
  }
  const pending = state.orders.find(
    (order) =>
      order.status === "pending" &&
      !order.brokerOrderNo &&
      order.activeClass !== "ORPHANED_LOCAL" &&
      order.activeClass !== "HISTORICAL_MATCHED",
  );
  if (pending) {
    return `진행 중 주문(${pending.name})의 증권사 응답을 기다리는 중입니다.`;
  }
  return null;
}

export function openCircuit(
  state: AppState,
  reason: string,
  order?: Order,
  kind: CircuitKind = order?.status === "unknown" ? "unknown" : "hard",
): AppState {
  const unknownCount =
    (state.circuit?.unknownCount ?? 0) + (order && isActiveUnknownBlocker(order) ? 1 : 0);
  return {
    ...state,
    circuit: {
      halted: true,
      kind,
      reason,
      unknownCount: Math.max(unknownCount, 1),
      openedAt: state.circuit?.openedAt ?? new Date().toISOString(),
      lastError: reason,
    },
  };
}

export function resetCircuit(state: AppState): { state: AppState; error?: string } {
  const unknown = findActiveUnknownOrder(state);
  if (unknown) {
    return {
      state,
      error:
        unknown.reason ??
        `현재 PAPER 미확인 주문 ${unknown.id} 를 먼저 증권사 체결내역과 맞춘 뒤 해제하세요.`,
    };
  }
  return {
    state: {
      ...state,
      circuit: {
        halted: false,
        kind: undefined,
        unknownCount: state.circuit?.unknownCount ?? 0,
        lastError: undefined,
        reason: undefined,
        openedAt: undefined,
      },
    },
  };
}
