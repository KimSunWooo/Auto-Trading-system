/**
 * Interval / rule execution budgets.
 * Unset fields are NEVER treated as unlimited — conservative defaults apply.
 */
import type { AppState, Order } from "@/lib/types";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { UserRule } from "@/src/rules/params";
import { HARD_LIMITS, seoulDay } from "@/src/risk/limits";
import { paperMaxPositionQtyPerSymbol } from "@/src/risk/order-policy";
import { nowMs } from "@/src/clock";

/** One Seoul calendar day in ms — default min gap between interval buys when unset. */
export const DEFAULT_MIN_BUY_INTERVAL_MS = 86_400_000;

export type ExecutionBudgetLimits = {
  maxExecutionsPerDay: number;
  maxDailyBuyKrw: number;
  maxPositionQty: number;
  maxPositionKrw: number;
  maxTotalExposurePct: number;
  /** Minimum time between BUY attempts (evaluation may be faster). */
  minBuyIntervalMs: number;
};

function countsTowardDaily(order: Order): boolean {
  if (order.parentOrderId) return false;
  if (order.side !== "buy") return false;
  return order.status === "filled" || order.status === "pending" || order.status === "unknown";
}

function ruleOrdersOnDay(
  state: Pick<AppState, "orders">,
  rule: UserRule,
  day: string,
): Order[] {
  return state.orders.filter(
    (order) =>
      countsTowardDaily(order) &&
      order.ruleId === rule.id &&
      order.code === rule.ticker &&
      seoulDay(new Date(order.createdAt)) === day,
  );
}

/**
 * Resolve budgets for a rule. Missing fields → conservative defaults (not unlimited).
 * Interval DCA defaults to 1 buy/day and one slice of notional.
 */
export function resolveExecutionBudget(
  rule: UserRule,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ExecutionBudgetLimits {
  const maxExecutionsPerDay =
    rule.maxExecutionsPerDay != null && rule.maxExecutionsPerDay > 0
      ? Math.floor(rule.maxExecutionsPerDay)
      : 1;

  const maxDailyBuyKrw =
    rule.maxDailyBuyKrw != null && rule.maxDailyBuyKrw > 0
      ? Math.floor(rule.maxDailyBuyKrw)
      : Math.min(HARD_LIMITS.maxDailyBuyKrw, Math.max(rule.sliceKrw, 1) * maxExecutionsPerDay);

  const paperPosCap = paperMaxPositionQtyPerSymbol(env);
  const maxPositionQty =
    rule.maxPositionQty != null && rule.maxPositionQty > 0
      ? Math.floor(rule.maxPositionQty)
      : Math.min(paperPosCap, Math.max(1, Math.floor(rule.budget / Math.max(rule.sliceKrw, 1)) || 1));

  const maxPositionKrw =
    rule.maxPositionKrw != null && rule.maxPositionKrw > 0
      ? Math.floor(rule.maxPositionKrw)
      : Math.min(
          Math.max(rule.budget, rule.sliceKrw),
          Math.max(rule.sliceKrw, 1) * maxPositionQty,
        );

  const maxTotalExposurePct =
    rule.maxTotalExposurePct != null &&
    rule.maxTotalExposurePct > 0 &&
    rule.maxTotalExposurePct <= 1
      ? rule.maxTotalExposurePct
      : HARD_LIMITS.maxPositionWeight;

  const minBuyIntervalMs =
    rule.minBuyIntervalMs != null && rule.minBuyIntervalMs > 0
      ? Math.floor(rule.minBuyIntervalMs)
      : rule.kind === "interval"
        ? DEFAULT_MIN_BUY_INTERVAL_MS
        : Math.max(rule.intervalMs, 1_000);

  return {
    maxExecutionsPerDay,
    maxDailyBuyKrw,
    maxPositionQty,
    maxPositionKrw,
    maxTotalExposurePct,
    minBuyIntervalMs,
  };
}

export type BudgetCheckInput = {
  /** Only the book fields budget checks need — callers need not synthesize a full AppState. */
  state: Pick<AppState, "orders" | "positions" | "totalDeposit">;
  rule: UserRule;
  bucket: AccountBucket;
  /** Planned buy notional (KRW). */
  amountKrw: number;
  /** Reference price for qty / exposure estimate. */
  price: number;
  nowMs: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

/**
 * Returns a human-readable block reason, or null when a BUY may proceed.
 * Evaluation cadence is separate — callers may still update lastEvaluatedAt.
 */
export function checkExecutionBudget(input: BudgetCheckInput): string | null {
  const { state, rule, bucket, amountKrw, price, nowMs } = input;
  if (!(amountKrw > 0) || !(price > 0)) return "예산 산출 불가";

  const limits = resolveExecutionBudget(rule, input.env ?? process.env);
  const day = seoulDay(new Date(nowMs));
  const today = ruleOrdersOnDay(state, rule, day);

  if (today.length >= limits.maxExecutionsPerDay) {
    return `일일 실행 한도 ${limits.maxExecutionsPerDay}회에 도달했습니다.`;
  }

  const boughtKrw = today.reduce((sum, order) => sum + (order.amount || order.net || 0), 0);
  if (boughtKrw + amountKrw > limits.maxDailyBuyKrw) {
    return `일일 매수 한도 ${limits.maxDailyBuyKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
  }

  const lastBuyAt = bucket.lastRunAt ? new Date(bucket.lastRunAt).getTime() : 0;
  if (lastBuyAt > 0 && nowMs - lastBuyAt < limits.minBuyIntervalMs) {
    return "매수 실행 주기 대기 중 (평가만 수행)";
  }

  const estQty = Math.floor(amountKrw / price);
  if (estQty < 1) {
    return "1주 매수 자금 부족";
  }
  const heldQty = state.positions
    .filter((p) => p.code === rule.ticker)
    .reduce((sum, p) => sum + p.qty, 0);
  if (heldQty + estQty > limits.maxPositionQty) {
    return `포지션 수량 한도 ${limits.maxPositionQty}주를 초과합니다.`;
  }

  const heldValue = (heldQty + estQty) * price;
  if (heldValue > limits.maxPositionKrw) {
    return `포지션 금액 한도 ${limits.maxPositionKrw.toLocaleString("ko-KR")}원을 초과합니다.`;
  }

  const equity = Math.max(1, state.totalDeposit || heldValue);
  if (heldValue / equity > limits.maxTotalExposurePct) {
    return `종목 노출 한도 ${(limits.maxTotalExposurePct * 100).toFixed(0)}%를 초과합니다.`;
  }

  return null;
}
