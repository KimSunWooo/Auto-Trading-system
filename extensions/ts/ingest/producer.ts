/**
 * Independent quote ingest process.
 * WS callback path: parse + enqueue only. Publish loop handles batch/ACK/retry.
 * Default source = fixture replay until shared WS session impact is measured.
 */
import type { MarketEvent, MarketEventKind, IngestMetrics } from "../shared/types.ts";
import type { MarketEventBus } from "../shared/file-bus.ts";
import { TICKER_QUOTES_TOPIC } from "../shared/file-bus.ts";
import { BoundedQueue } from "./bounded-queue.ts";
import { parseRealtimeFramesToEvents } from "./parse-bridge.ts";

export type IngestConfig = {
  queueCapacity?: number;
  batchSize?: number;
  batchWaitMs?: number;
  maxRetries?: number;
  /** ORDERBOOK coalesce under load (latest per symbol). */
  coalesceOrderBook?: boolean;
  emitOrderBookStub?: boolean;
};

const DEFAULTS = {
  queueCapacity: 2_000,
  batchSize: 50,
  batchWaitMs: 25,
  maxRetries: 3,
  coalesceOrderBook: true,
  emitOrderBookStub: false,
};

export class QuoteIngestProducer {
  readonly metrics: IngestMetrics = {
    enqueued: 0,
    published: 0,
    droppedQueue: 0,
    droppedTrades: 0,
    orderbookMerged: 0,
    publishErrors: 0,
  };

  private readonly queue: BoundedQueue<MarketEvent>;
  private readonly cfg: Required<IngestConfig>;
  private running = false;
  private seenTradeIds = new Set<string>();

  constructor(
    private readonly bus: MarketEventBus,
    cfg: IngestConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.queue = new BoundedQueue<MarketEvent>(this.cfg.queueCapacity, (item, reason) => {
      this.metrics.droppedQueue += 1;
      if (item.kind === "TRADE") this.metrics.droppedTrades += 1;
      if (reason === "superseded" && item.kind === "ORDERBOOK") {
        this.metrics.orderbookMerged += 1;
      }
    });
  }

  /**
   * WebSocket / fixture callback — keep work minimal.
   */
  onRawFrame(raw: string, receivedTsMs = Date.now()): void {
    const { events } = parseRealtimeFramesToEvents(raw, receivedTsMs, {
      emitOrderBookStub: this.cfg.emitOrderBookStub,
    });
    for (const event of events) {
      this.enqueue(event);
    }
  }

  enqueue(event: MarketEvent): void {
    this.metrics.enqueued += 1;
    if (event.kind === "ORDERBOOK" && this.cfg.coalesceOrderBook) {
      this.queue.enqueue(event, {
        mergeKey: `ORDERBOOK:${event.symbol}`,
        keyOf: (e) => (e.kind === "ORDERBOOK" ? `ORDERBOOK:${e.symbol}` : e.eventId),
      });
      return;
    }
    this.queue.enqueue(event);
  }

  async startPublishLoop(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running && !signal?.aborted) {
      const batch = this.queue.drain(this.cfg.batchSize);
      if (batch.length === 0) {
        await sleep(this.cfg.batchWaitMs);
        continue;
      }
      for (const event of batch) {
        await this.publishWithRetry(event);
      }
    }
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }

  private async publishWithRetry(event: MarketEvent): Promise<void> {
    if (event.kind === "TRADE") {
      if (this.seenTradeIds.has(event.eventId)) return;
      this.seenTradeIds.add(event.eventId);
      if (this.seenTradeIds.size > 50_000) {
        // Bound memory — drop oldest half by rebuilding.
        this.seenTradeIds = new Set([...this.seenTradeIds].slice(-25_000));
      }
    }
    let lastErr = "";
    for (let attempt = 0; attempt < this.cfg.maxRetries; attempt++) {
      const result = await this.bus.publish(TICKER_QUOTES_TOPIC, event);
      if (result.ok) {
        this.metrics.published += 1;
        return;
      }
      lastErr = result.error;
      await sleep(10 * (attempt + 1));
    }
    this.metrics.publishErrors += 1;
    this.metrics.lastError = lastErr;
    if (event.kind === "TRADE") this.metrics.droppedTrades += 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { MarketEventKind };
