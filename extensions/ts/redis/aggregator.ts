/**
 * Consumes ticker-quotes and maintains UI-only latest + 10m OHLCV.
 * Never wired into OrderManager / KisBroker quote path.
 */
import type { MarketEventBus } from "../shared/file-bus.ts";
import { TICKER_QUOTES_TOPIC } from "../shared/file-bus.ts";
import type { TradeEvent } from "../shared/types.ts";
import { QuoteCacheStore } from "./memory-store.ts";

export type AggregatorStats = {
  trades: number;
  duplicates: number;
  late: number;
  orderbooksIgnored: number;
  tradeDropsMarked: number;
};

export class UiQuoteAggregator {
  readonly store = new QuoteCacheStore();
  readonly stats: AggregatorStats = {
    trades: 0,
    duplicates: 0,
    late: 0,
    orderbooksIgnored: 0,
    tradeDropsMarked: 0,
  };

  constructor(private readonly bus: MarketEventBus) {}

  /** One-shot drain of bus topic (file/memory). */
  async consumeAll(): Promise<AggregatorStats> {
    const events = await this.bus.readAll(TICKER_QUOTES_TOPIC);
    for (const event of events) {
      this.apply(event);
    }
    return this.stats;
  }

  apply(event: import("../shared/types.ts").MarketEvent): void {
    if (event.kind === "ORDERBOOK") {
      // UI cache does not need full book for v1; research consumer handles imbalance.
      this.stats.orderbooksIgnored += 1;
      return;
    }
    const trade = event as TradeEvent;
    const result = this.store.applyTrade(trade);
    if (result.duplicate) {
      this.stats.duplicates += 1;
      return;
    }
    this.stats.trades += 1;
    if (result.late) this.stats.late += 1;
  }

  /** Ingest producer reports a dropped TRADE — mark that minute incomplete. */
  noteTradeDrop(symbol: string, atMs: number): void {
    this.store.markTradeDrop(symbol, atMs);
    this.stats.tradeDropsMarked += 1;
  }
}
