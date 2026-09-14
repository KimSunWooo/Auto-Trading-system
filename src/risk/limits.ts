import type { AppState, Order, Side } from "@/lib/types";

/** Caps that still apply if the local book is wrong. */
export const HARD_LIMITS = {
  maxOrderKrw: 2_000_000,
  maxDailyBuyKrw: 5_000_000,
  maxDailyOrders: 30,
  maxPositionWeight: 0.5,
  minTickMs: 2_500,
  quoteTimeoutMs: 8_000,
  orderTimeoutMs: 10_000,
  cancelUnfilledAfterMs: 30_000,
} as const;

export function seoulDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

function countsTowardDaily(order: Order): boolean {
  if (order.parentOrderId) return false;
  return order.status === "filled" || order.status === "pending" || order.status === "unknown";
}

export function checkHardLimits(
  state: AppState,
  input: { side: Side; ticker: string; qty: number; price: number },
): string | null {
  const notional = input.qty * input.price;
  if (notional > HARD_LIMITS.maxOrderKrw) {
    return `주문 1건 한도 ${HARD_LIMITS.maxOrderKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
  }

  const today = seoulDay();
  const todays = state.orders.filter(
    (order) => countsTowardDaily(order) && seoulDay(new Date(order.createdAt)) === today,
  );
  if (todays.length >= HARD_LIMITS.maxDailyOrders) {
    return `일일 주문 ${HARD_LIMITS.maxDailyOrders}건 한도에 도달했습니다.`;
  }

  if (input.side === "buy") {
    const bought = todays
      .filter((order) => order.side === "buy")
      .reduce((sum, order) => sum + order.amount, 0);
    if (bought + notional > HARD_LIMITS.maxDailyBuyKrw) {
      return `일일 매수 한도 ${HARD_LIMITS.maxDailyBuyKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
    }

    const quote = state.quotes[input.ticker];
    const last = quote?.price ?? input.price;
    const held =
      state.positions
        .filter((p) => p.code === input.ticker)
        .reduce((sum, p) => sum + p.qty, 0) + input.qty;
    const weight = (held * last) / Math.max(1, state.totalDeposit);
    if (weight > HARD_LIMITS.maxPositionWeight) {
      return `종목 비중 한도 ${(HARD_LIMITS.maxPositionWeight * 100).toFixed(0)}%를 초과합니다.`;
    }
  }

  return null;
}
