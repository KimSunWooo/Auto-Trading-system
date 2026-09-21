import type { Quote } from "@/lib/types";
import { brokerDriver } from "@/src/brokers/kis-config";
import { isLiveLike, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { nowMs } from "@/src/clock";

/** Keep in sync with CONTROLLED_RUN_QUOTE_FRESH_MS — do not import controlled-run (client-safe). */
export const LIVE_KIS_QUOTE_FRESH_MS = 15_000;

/** LIVE_TEST|LIVE + BROKER=kis — only KIS quotes are valid current prices. */
export function usesLiveKisQuotes(env: EnvMap = process.env): boolean {
  return isLiveLike(tradingMode(env)) && brokerDriver(env) === "kis";
}

export function isMockOrSeedQuote(quote: Quote | null | undefined): boolean {
  if (!quote) return false;
  return quote.source === "mock" || quote.source === "seed" || quote.source == null;
}

export function isFreshKisQuote(
  quote: Quote | null | undefined,
  now = nowMs(),
  maxAgeMs = LIVE_KIS_QUOTE_FRESH_MS,
): boolean {
  if (!quote) return false;
  if (quote.source !== "kis") return false;
  if (!quote.freshAt || !(quote.price > 0)) return false;
  return now - quote.freshAt <= maxAgeMs;
}

/** Order decision gate: live-kis mode accepts only fresh KIS quotes. */
export function isOrderableQuote(
  quote: Quote | null | undefined,
  opts: { liveKis?: boolean; now?: number } = {},
): boolean {
  const liveKis = opts.liveKis ?? usesLiveKisQuotes();
  if (!liveKis) return Boolean(quote && quote.price > 0);
  return isFreshKisQuote(quote, opts.now ?? nowMs());
}

export type QuoteDisplayKind = "KIS_LIVE" | "STALE" | "MOCK" | "SEED" | "UNAVAILABLE";

export function quoteDisplayKind(
  quote: Quote | null | undefined,
  opts: { liveKis?: boolean; now?: number } = {},
): QuoteDisplayKind {
  if (!quote) return "UNAVAILABLE";
  const liveKis = opts.liveKis ?? usesLiveKisQuotes();
  if (quote.source === "kis") {
    if (isFreshKisQuote(quote, opts.now ?? nowMs())) return "KIS_LIVE";
    return "STALE";
  }
  if (liveKis) {
    // mock/seed must never look like a live price in live-kis mode
    return "UNAVAILABLE";
  }
  if (quote.source === "mock") return "MOCK";
  if (quote.source === "seed") return "SEED";
  return "UNAVAILABLE";
}

/**
 * Strip persisted mock/seed quotes from the current book under live KIS.
 * Does not touch orders, intents, positions, or other ledger fields.
 */
export function invalidateNonKisQuotes(
  quotes: Record<string, Quote>,
  env: EnvMap = process.env,
): Record<string, Quote> {
  if (!usesLiveKisQuotes(env)) return quotes;
  const next: Record<string, Quote> = {};
  for (const [code, quote] of Object.entries(quotes)) {
    if (quote.source === "kis") next[code] = quote;
  }
  return next;
}

/** Quotes safe to show as “current” on the dashboard. */
export function filterDashboardQuotes(
  quotes: Record<string, Quote>,
  opts: { liveKis?: boolean; currentSymbols?: string[]; now?: number } = {},
): Quote[] {
  const liveKis = opts.liveKis ?? usesLiveKisQuotes();
  const symbols = opts.currentSymbols?.length ? new Set(opts.currentSymbols) : null;
  const rows = Object.values(quotes).filter((row) => (symbols ? symbols.has(row.code) : true));
  if (!liveKis) return rows;
  return rows.filter((row) => {
    const kind = quoteDisplayKind(row, { liveKis: true, now: opts.now });
    return kind === "KIS_LIVE" || kind === "STALE";
  });
}

export function quoteFreshnessLabel(
  quote: Quote | null | undefined,
  opts: { liveKis?: boolean; now?: number } = {},
): string {
  const now = opts.now ?? nowMs();
  const kind = quoteDisplayKind(quote, { liveKis: opts.liveKis, now });
  if (kind === "KIS_LIVE" && quote?.freshAt) {
    const ageSec = Math.max(0, Math.round((now - quote.freshAt) / 1000));
    return `KIS · ${ageSec}초 전`;
  }
  if (kind === "STALE") return "KIS · 시세 지연";
  if (kind === "MOCK") return "MOCK";
  if (kind === "SEED") return "SEED";
  return "시세 없음";
}
