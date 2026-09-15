import { nowMs } from "@/src/clock";
import type { BrokerFill, IBroker } from "@/src/brokers/IBroker";
import { getMarketClock } from "@/lib/market-hours";
import { ceilToTick, clampDailyLimit, floorToTick } from "@/lib/tick-size";
import type { AppState, Side } from "@/lib/types";

/**
 * Order-entry interceptor + protected execution.
 *
 * - New tickets only during KRX continuous session 09:00–15:20 KST.
 *   Opening/closing auction (동시호가), weekends, holidays, and after-hours
 *   are blocked. ignoreMarketHours never bypasses this rail.
 * - Every market intent is rewritten to a ±3% limit band (VI / thin-book shock).
 * - Stop-loss / kill-switch sells use the same band and slice size.
 */
export const EXECUTION_POLICY = {
  bandPct: 0.03,
  maxSliceKrw: 500_000,
  regularOpenHhmm: 900,
  /** Exclusive. 15:20 is closing auction, not continuous trading. */
  regularCloseHhmm: 1520,
} as const;

/** Historical high-vol names. All tickers now rewrite market → band; kept for tests/docs. */
export const NO_MARKET_TICKERS = new Set(["247540", "086520", "196170"]);

export type BandSlice = {
  qty: number;
  price: number;
  ordDvsn: "limit";
};

export function forbidsMarketOrder(_ticker?: string): boolean {
  return true;
}

export function sessionBlockReason(
  _state?: Pick<AppState, "settings">,
  now = nowMs(),
  _opts: { forceRegularSession?: boolean } = {},
): string | null {
  const clock = getMarketClock(new Date(now));
  if (clock.open) return null;
  return `정규장(09:00~15:20) 외에는 신규 주문을 낼 수 없습니다. 현재 세션: ${clock.sessionLabel}.`;
}

export function bandLimitPrice(side: Side, last: number, prevClose = last): number {
  if (!(last > 0)) return 0;
  const raw = side === "buy" ? last * (1 + EXECUTION_POLICY.bandPct) : last * (1 - EXECUTION_POLICY.bandPct);
  const aligned = side === "buy" ? ceilToTick(raw) : floorToTick(raw);
  return clampDailyLimit(aligned, prevClose > 0 ? prevClose : last);
}

export function splitQty(qty: number, price: number, maxSliceKrw = EXECUTION_POLICY.maxSliceKrw): number[] {
  if (qty < 1 || !(price > 0)) return [];
  const maxQtyPerSlice = Math.max(1, Math.floor(maxSliceKrw / price));
  const slices: number[] = [];
  let left = qty;
  while (left > 0) {
    const take = Math.min(left, maxQtyPerSlice);
    slices.push(take);
    left -= take;
  }
  return slices;
}

export function planBandSlices(
  side: Side,
  qty: number,
  last: number,
  prevClose = last,
): BandSlice[] {
  const price = bandLimitPrice(side, last, prevClose);
  if (!(price > 0)) return [];
  return splitQty(qty, last).map((sliceQty) => ({
    qty: sliceQty,
    price,
    ordDvsn: "limit" as const,
  }));
}

export function resolveMarketIntent(
  ticker: string,
  side: Side,
  last: number,
  prevClose = last,
): { ordDvsn: "limit"; price: number; converted: boolean; reason: string } {
  const pct = Math.round(EXECUTION_POLICY.bandPct * 100);
  return {
    ordDvsn: "limit",
    price: bandLimitPrice(side, last, prevClose),
    converted: true,
    reason: `${ticker} 시장가 충격을 막기 위해 현재가 ±${pct}% 지정가로 전환합니다.`,
  };
}

/**
 * Stop-loss / kill-switch path. Caps slippage at the band and does not treat
 * a broker ack as a fill — each slice goes through IBroker.sellLimit.
 */
export async function sellBandSlices(
  broker: Pick<IBroker, "sellLimit">,
  ticker: string,
  qty: number,
  last: number,
  prevClose = last,
): Promise<BrokerFill> {
  const slices = planBandSlices("sell", qty, last, prevClose);
  if (slices.length === 0) {
    return {
      ok: false,
      status: "rejected",
      ticker,
      side: "sell",
      qty: 0,
      price: last,
      amount: 0,
      net: 0,
      reason: "분할할 매도 수량이 없습니다.",
    };
  }

  let lastFill: BrokerFill | undefined;
  for (const slice of slices) {
    const fill = await broker.sellLimit(ticker, slice.price, slice.qty);
    if (fill.status === "unknown") return fill;
    if (fill.ok || fill.status === "pending") {
      lastFill = fill;
      continue;
    }
    if (lastFill) return lastFill;
    lastFill = fill;
    break;
  }
  return lastFill!;
}
