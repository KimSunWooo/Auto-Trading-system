/**
 * In-process Redis stand-in for UI quote cache + 10-minute OHLCV.
 * Mirrors the intended Redis key layout so a real ioredis adapter can swap in.
 */
import type { LatestQuote, MinuteBar, TradeEvent } from "../shared/types.ts";

const TEN_MINUTES_MS = 10 * 60_000;

export function minuteStart(tsMs: number): number {
  return Math.floor(tsMs / 60_000) * 60_000;
}

export class QuoteCacheStore {
  private readonly latest = new Map<string, LatestQuote>();
  /** symbol → minuteStartMs → bar */
  private readonly bars = new Map<string, Map<number, MinuteBar>>();
  /** Dedup TRADE eventIds per symbol (bounded). */
  private readonly seen = new Map<string, Set<string>>();
  private readonly incompleteMinutes = new Map<string, Set<number>>();

  getLatest(symbol: string): LatestQuote | undefined {
    return this.latest.get(symbol);
  }

  getBars(symbol: string): MinuteBar[] {
    const map = this.bars.get(symbol);
    if (!map) return [];
    return [...map.values()].sort((a, b) => a.minuteStartMs - b.minuteStartMs);
  }

  markTradeDrop(symbol: string, atMs: number): void {
    const m = minuteStart(atMs);
    const set = this.incompleteMinutes.get(symbol) ?? new Set();
    set.add(m);
    this.incompleteMinutes.set(symbol, set);
    const bar = this.bars.get(symbol)?.get(m);
    if (bar) bar.incomplete = true;
  }

  applyTrade(event: TradeEvent): { applied: boolean; duplicate: boolean; late: boolean } {
    const seen = this.seen.get(event.symbol) ?? new Set();
    if (seen.has(event.eventId)) {
      return { applied: false, duplicate: true, late: false };
    }
    seen.add(event.eventId);
    if (seen.size > 20_000) {
      this.seen.set(event.symbol, new Set([...seen].slice(-10_000)));
    } else {
      this.seen.set(event.symbol, seen);
    }

    const prev = this.latest.get(event.symbol);
    const late = Boolean(prev && event.exchangeTsMs + 5_000 < prev.exchangeTsMs);
    // Latest quote: only advance on non-stale exchange time (or first).
    if (!prev || event.exchangeTsMs >= prev.exchangeTsMs) {
      this.latest.set(event.symbol, {
        symbol: event.symbol,
        price: event.price,
        bid: event.bid,
        ask: event.ask,
        exchangeTsMs: event.exchangeTsMs,
        receivedTsMs: event.receivedTsMs,
        eventId: event.eventId,
      });
    }

    const m = minuteStart(event.exchangeTsMs);
    const byMinute = this.bars.get(event.symbol) ?? new Map();
    const existing = byMinute.get(m);
    const incomplete =
      existing?.incomplete ||
      (this.incompleteMinutes.get(event.symbol)?.has(m) ?? false);

    if (!existing) {
      byMinute.set(m, {
        minuteStartMs: m,
        open: event.price,
        high: event.price,
        low: event.price,
        close: event.price,
        volume: event.tradeVolume,
        tradeCount: 1,
        incomplete,
        updatedAtMs: event.receivedTsMs,
      });
    } else {
      // Late trades update OHLC carefully; volume only if not duplicate (already guarded).
      existing.high = Math.max(existing.high, event.price);
      existing.low = Math.min(existing.low, event.price);
      if (!late || event.exchangeTsMs >= existing.updatedAtMs) {
        existing.close = event.price;
      }
      existing.volume += event.tradeVolume;
      existing.tradeCount += 1;
      existing.incomplete = incomplete;
      existing.updatedAtMs = Math.max(existing.updatedAtMs, event.receivedTsMs);
    }
    this.bars.set(event.symbol, byMinute);
    this.expire(event.symbol, event.receivedTsMs);
    return { applied: true, duplicate: false, late };
  }

  private expire(symbol: string, nowMs: number): void {
    const byMinute = this.bars.get(symbol);
    if (!byMinute) return;
    const cutoff = nowMs - TEN_MINUTES_MS;
    for (const key of [...byMinute.keys()]) {
      if (key < cutoff) byMinute.delete(key);
    }
    const incomplete = this.incompleteMinutes.get(symbol);
    if (incomplete) {
      for (const key of [...incomplete]) {
        if (key < cutoff) incomplete.delete(key);
      }
    }
  }
}
