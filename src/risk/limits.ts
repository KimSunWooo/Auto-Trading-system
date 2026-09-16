import type { AppState, Order, Side } from "@/lib/types";
import { checkPaperOrderConstraints, usesPaperOrderPolicy } from "@/src/risk/order-policy";
import { liveTestCaps, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";

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
  balanceSyncMs: 30_000,
  /** Rounding only. Not derived from the 0.015% local fee estimate. */
  balanceCashToleranceKrw: 1,
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
  env: EnvMap = process.env,
): string | null {
  if (usesPaperOrderPolicy(env)) {
    if (input.side === "buy") {
      const paper = checkPaperOrderConstraints({
        qty: input.qty,
        ticker: input.ticker,
        state,
      });
      if (!paper.ok) return paper.blocked;
    }
    return null;
  }

  const live = tradingMode(env) === "live_test" ? liveTestCaps(env) : null;
  const maxOrderKrw = live ? Math.min(HARD_LIMITS.maxOrderKrw, live.maxOrderKrw) : HARD_LIMITS.maxOrderKrw;
  const maxDailyBuyKrw = live
    ? Math.min(HARD_LIMITS.maxDailyBuyKrw, live.maxDailyBuyKrw)
    : HARD_LIMITS.maxDailyBuyKrw;
  const maxDailyOrders = live
    ? Math.min(HARD_LIMITS.maxDailyOrders, live.maxDailyOrders)
    : HARD_LIMITS.maxDailyOrders;

  const notional = input.qty * input.price;
  if (notional > maxOrderKrw) {
    return `주문 1건 한도 ${maxOrderKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
  }

  const today = seoulDay();
  const todays = state.orders.filter(
    (order) => countsTowardDaily(order) && seoulDay(new Date(order.createdAt)) === today,
  );
  if (todays.length >= maxDailyOrders) {
    return `일일 주문 ${maxDailyOrders}건 한도에 도달했습니다.`;
  }

  if (input.side === "buy") {
    const bought = todays
      .filter((order) => order.side === "buy")
      .reduce((sum, order) => sum + order.amount, 0);
    if (bought + notional > maxDailyBuyKrw) {
      return `일일 매수 한도 ${maxDailyBuyKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
    }

    const quote = state.quotes[input.ticker];
    const last = quote?.price ?? input.price;
    const heldQty =
      state.positions.filter((p) => p.code === input.ticker).reduce((sum, p) => sum + p.qty, 0) +
      input.qty;
    const heldValue = heldQty * last;
    const weight = heldValue / Math.max(1, state.totalDeposit);
    if (weight > HARD_LIMITS.maxPositionWeight) {
      return `종목 비중 한도 ${(HARD_LIMITS.maxPositionWeight * 100).toFixed(0)}%를 초과합니다.`;
    }
    if (live && heldValue > live.maxPositionKrw) {
      return `LIVE_TEST 포지션 한도 ${live.maxPositionKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
    }
    if (live) {
      const names = new Set(state.positions.filter((p) => p.qty > 0).map((p) => p.code));
      names.add(input.ticker);
      if (names.size > live.maxPositionCount) {
        return `LIVE_TEST 종목 수 한도 ${live.maxPositionCount}개를 초과합니다.`;
      }
    }
  }

  return null;
}
