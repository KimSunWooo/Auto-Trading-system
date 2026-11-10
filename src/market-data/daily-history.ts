/**
 * Trade-day-aware daily close history for MA rules.
 * Same Seoul trade day → update one developing bar.
 * Different trade days with the same close → keep both bars.
 * Undated histories must not invent days from live ticks.
 */

export const MAX_SUPPORTED_DAILY_BARS = 40;

export type DailyCloseBar = {
  /** Seoul calendar trade date YYYYMMDD */
  tradeDate: string;
  close: number;
};

/** Asia/Seoul trade date as YYYYMMDD. */
export function seoulTradeDate(atMs = Date.now()): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(atMs));
  return ymd.replace(/-/g, "");
}

export function normalizeTradeDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 8) return digits;
  return null;
}

export function mergeLiveIntoDailyBars(
  daily: DailyCloseBar[],
  live: { tradeDate: string; price: number },
  maxBars = MAX_SUPPORTED_DAILY_BARS,
): DailyCloseBar[] {
  const base = daily
    .filter((b) => Number.isFinite(b.close) && b.close > 0 && Boolean(normalizeTradeDate(b.tradeDate)))
    .map((b) => ({ tradeDate: normalizeTradeDate(b.tradeDate)!, close: b.close }))
    .slice(-maxBars);
  const tradeDate = normalizeTradeDate(live.tradeDate);
  if (!(live.price > 0) || !tradeDate) return base.slice(-maxBars);
  if (base.length === 0) return [{ tradeDate, close: live.price }];
  const last = base[base.length - 1]!;
  if (last.tradeDate === tradeDate) {
    return [...base.slice(0, -1), { tradeDate, close: live.price }].slice(-maxBars);
  }
  return [...base, { tradeDate, close: live.price }].slice(-maxBars);
}

/**
 * Merge live price into daily closes.
 * Prefer dated bars via opts.dailyTradeDates + opts.liveTradeDate.
 * Without dates: never append a new synthetic day from a live tick.
 */
export function mergeLiveIntoDailyCloses(
  daily: number[],
  livePrice: number,
  opts?: {
    maxBars?: number;
    liveTradeDate?: string;
    dailyTradeDates?: string[];
  },
): number[] {
  const maxBars = opts?.maxBars ?? MAX_SUPPORTED_DAILY_BARS;
  const dates = opts?.dailyTradeDates;
  const liveDate = normalizeTradeDate(opts?.liveTradeDate ?? null);
  if (dates && liveDate && dates.length === daily.length) {
    const bars: DailyCloseBar[] = [];
    for (let i = 0; i < daily.length; i += 1) {
      const d = normalizeTradeDate(dates[i] ?? null);
      const close = daily[i]!;
      if (!d || !(close > 0)) continue;
      bars.push({ tradeDate: d, close });
    }
    return mergeLiveIntoDailyBars(bars, { tradeDate: liveDate, price: livePrice }, maxBars).map(
      (b) => b.close,
    );
  }

  const base = daily.filter((n) => Number.isFinite(n) && n > 0).slice(-maxBars);
  if (!(livePrice > 0)) return base;
  // Undated: keep verified daily only — do not invent a new bar from live ticks.
  return base.slice(-maxBars);
}

export function closesFromBars(bars: DailyCloseBar[]): number[] {
  return bars.map((b) => b.close);
}
