import { nowIso } from "@/src/clock";
import type { AppState, Order, OrderIntent, Side } from "@/lib/types";

export const MAX_INTENTS = 400;

export function makeSignalId(parts: Array<string | number>): string {
  return parts.map((part) => String(part)).join(":");
}

export function findIntent(state: Pick<AppState, "intents">, intentId: string | undefined): OrderIntent | undefined {
  if (!intentId) return undefined;
  return (state.intents ?? []).find((row) => row.intentId === intentId);
}

export function findOrderByIntent(state: Pick<AppState, "orders">, intentId: string | undefined): Order | undefined {
  if (!intentId) return undefined;
  return state.orders.find((row) => row.intentId === intentId && !row.parentOrderId);
}

export function upsertIntent(
  state: AppState,
  input: {
    intentId: string;
    signalId: string;
    ruleId: string;
    ticker: string;
    side: Side;
    qty: number;
    price: number;
    reason: string;
  },
): { state: AppState; intent: OrderIntent; duplicate: boolean } {
  const existing = findIntent(state, input.intentId);
  if (existing) {
    return { state, intent: existing, duplicate: true };
  }
  const intent: OrderIntent = {
    intentId: input.intentId,
    signalId: input.signalId,
    ruleId: input.ruleId,
    ticker: input.ticker,
    side: input.side,
    qty: input.qty,
    price: input.price,
    createdAt: nowIso(),
    reason: input.reason,
    status: "pending",
  };
  return {
    state: {
      ...state,
      intents: [intent, ...(state.intents ?? [])].slice(0, MAX_INTENTS),
    },
    intent,
    duplicate: false,
  };
}

export function patchIntent(
  state: AppState,
  intentId: string | undefined,
  patch: Partial<OrderIntent>,
): AppState {
  if (!intentId) return state;
  return {
    ...state,
    intents: (state.intents ?? []).map((row) => (row.intentId === intentId ? { ...row, ...patch } : row)),
  };
}
