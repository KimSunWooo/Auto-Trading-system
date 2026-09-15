import { roundToTick, tickSize } from "@/lib/tick-size";
import { findStock, UNIVERSE } from "@/lib/universe";
import type { Quote } from "@/lib/types";
import { DEFAULT_STRATEGY_CONFIG } from "@/src/strategies/params";

export type Candle = {
  t: number;
  ticker: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(code: string): number {
  return [...code].reduce((sum, ch, i) => sum + ch.charCodeAt(0) * (i + 13), 97);
}

function nextWeekday(from: Date): Date {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + 1);
  const day = next.getUTCDay();
  if (day === 6) next.setUTCDate(next.getUTCDate() + 2);
  if (day === 0) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Deterministic daily candles for paper backtests (about 252 sessions / year). */
export function generateDailyCandles(tickers: string[], years = 2): Record<string, Candle[]> {
  const sessions = Math.max(60, Math.round(years * 252));
  const out: Record<string, Candle[]> = {};
  for (const ticker of tickers) {
    const seed = UNIVERSE.find((row) => row.code === ticker);
    let price = seed?.prevClose ?? 50_000;
    const rng = mulberry32(seedFrom(ticker));
    const vol = ticker === "069500" ? 0.008 : 0.016;
    const drift = ticker === "069500" ? 0.00025 : 0.00015;
    const rows: Candle[] = [];
    let cursor = new Date(Date.UTC(2024, 0, 2, 6, 0, 0));
    for (let i = 0; i < sessions; i++) {
      const ret = drift + (rng() - 0.47) * vol;
      const open = roundToTick(price);
      const close = roundToTick(Math.max(tickSize(price), price * (1 + ret)));
      const hi = roundToTick(Math.max(open, close) * (1 + rng() * 0.008));
      const lo = roundToTick(Math.max(tickSize(close), Math.min(open, close) * (1 - rng() * 0.008)));
      rows.push({
        t: cursor.getTime(),
        ticker,
        open,
        high: Math.max(hi, open, close),
        low: Math.min(lo, open, close),
        close,
        volume: Math.round(200_000 + rng() * 800_000),
      });
      price = close;
      cursor = nextWeekday(cursor);
    }
    out[ticker] = rows;
  }
  return out;
}

export function watchedBacktestTickers(): string[] {
  return [
    ...new Set([
      DEFAULT_STRATEGY_CONFIG.Level1_Stable.ticker,
      DEFAULT_STRATEGY_CONFIG.Level5_Swing.ticker,
      ...DEFAULT_STRATEGY_CONFIG.Level10_Aggressive.universe,
    ]),
  ];
}

export function quoteFromCandle(
  candle: Candle,
  prevClose: number,
  history: number[],
): Quote {
  const stock = findStock(candle.ticker);
  const tick = tickSize(candle.close);
  return {
    code: candle.ticker,
    name: stock?.name ?? candle.ticker,
    market: stock?.market ?? "KOSPI",
    price: candle.close,
    prevClose: prevClose || candle.open,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    volume: candle.volume,
    bid: roundToTick(Math.max(tick, candle.close - tick)),
    ask: roundToTick(candle.close + tick),
    history: [...history, candle.close].slice(-80),
  };
}
