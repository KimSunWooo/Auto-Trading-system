import type { Quote } from "@/lib/types";
import { type EnvMap } from "@/src/runtime/trading-mode";
import { nowMs } from "@/src/clock";
import { formatSeoulTime } from "@/lib/format";

/** Keep in sync with CONTROLLED_RUN_QUOTE_FRESH_MS — do not import controlled-run (client-safe). */
export const LIVE_KIS_QUOTE_FRESH_MS = 15_000;

/**
 * Production is KIS-only: only fresh KIS quotes are valid current prices.
 * Trading mode paper still uses KIS quotes (never a local mock book).
 */
export function usesLiveKisQuotes(_env: EnvMap = process.env): boolean {
  return true;
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

/**
 * UI display classification.
 * When `now` is omitted, KIS quotes are not age-classified (hydration-safe).
 * Pass an explicit `now` only after client mount for STALE / orderable UI.
 */
export function quoteDisplayKind(
  quote: Quote | null | undefined,
  opts: { liveKis?: boolean; now?: number } = {},
): QuoteDisplayKind {
  if (!quote) return "UNAVAILABLE";
  const liveKis = opts.liveKis ?? usesLiveKisQuotes();
  if (quote.source === "kis") {
    if (opts.now == null) return "KIS_LIVE";
    if (isFreshKisQuote(quote, opts.now)) return "KIS_LIVE";
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
 * Drop persisted non-KIS quotes from the book (legacy mock/seed discarded).
 * Does not touch orders, intents, positions, or other ledger fields.
 */
export function invalidateNonKisQuotes(
  quotes: Record<string, Quote>,
  _env?: EnvMap,
): Record<string, Quote> {
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

/**
 * Hydration-safe freshness text (pair with a separate source tag in the UI).
 * Uses Asia/Seoul absolute clock from `freshAt` (same SSR/client string).
 * “시세 지연” only when an explicit `now` is provided (post-mount).
 */
export function quoteFreshnessLabel(
  quote: Quote | null | undefined,
  opts: { liveKis?: boolean; now?: number } = {},
): string {
  if (!quote) return "시세 없음";
  const liveKis = opts.liveKis ?? usesLiveKisQuotes();

  if (quote.source === "kis") {
    if (!quote.freshAt) return "—";
    const clock = formatSeoulTime(quote.freshAt);
    if (!clock) return "—";
    if (opts.now != null && !isFreshKisQuote(quote, opts.now)) {
      return `시세 지연 · ${clock}`;
    }
    return clock;
  }

  if (liveKis) return "시세 없음";
  if (quote.source === "mock") return "MOCK";
  if (quote.source === "seed") return "SEED";
  return "시세 없음";
}
