import type { AppState, CircuitKind, CircuitState, Order } from "@/lib/types";

export function emptyCircuit(): CircuitState {
  return { halted: false, unknownCount: 0 };
}

export function hasOpenRisk(state: AppState): boolean {
  return (
    Boolean(state.circuit?.halted) ||
    state.orders.some((order) => order.status === "unknown" || order.status === "pending")
  );
}

export function tradingBlocked(state: AppState): string | null {
  if (state.circuit?.halted) {
    return state.circuit.reason ?? "서킷 브레이커가 열려 주문을 차단했습니다.";
  }
  const unknown = state.orders.find((order) => order.status === "unknown");
  if (unknown) {
    return `미확인 주문(${unknown.name} ${unknown.qty}주)이 있어 신규 주문을 막습니다.`;
  }
  const pending = state.orders.find(
    (order) => order.status === "pending" && !order.brokerOrderNo,
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
  const unknownCount = (state.circuit?.unknownCount ?? 0) + (order?.status === "unknown" ? 1 : 0);
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
  const unknown = state.orders.find((order) => order.status === "unknown");
  if (unknown) {
    return {
      state,
      error: `미확인 주문 ${unknown.id} 를 먼저 증권사 체결내역과 맞춘 뒤 해제하세요.`,
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
