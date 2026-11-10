/**
 * Shared market-event contracts for the research extension bus.
 * Trading core never imports this module.
 */

export type MarketEventKind = "TRADE" | "ORDERBOOK";

export type MarketEventBase = {
  /** Kafka/file partition key: `{market}:{symbol}` */
  partitionKey: string;
  /** Stable id for dedupe: `{kind}:{market}:{symbol}:{exchangeTsMs}:{seq|hash}` */
  eventId: string;
  schemaVersion: "market-event.v1";
  kind: MarketEventKind;
  market: "KR";
  symbol: string;
  /** Exchange event time (ms epoch), when known. */
  exchangeTsMs: number;
  /** Ingest receive time (ms epoch). */
  receivedTsMs: number;
  /** Monotonic producer version for last-write-wins on ORDERBOOK. */
  version: number;
};

export type TradeEvent = MarketEventBase & {
  kind: "TRADE";
  price: number;
  /** Per-trade volume (CNTG_VOL). Never re-sum ACML_VOL into bars. */
  tradeVolume: number;
  bid?: number;
  ask?: number;
};

export type OrderBookLevel = { price: number; qty: number };

export type OrderBookEvent = MarketEventBase & {
  kind: "ORDERBOOK";
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /** When true, research imbalance detectors must stay disabled. */
  paperUnverified: boolean;
};

export type MarketEvent = TradeEvent | OrderBookEvent;

export type MinuteBar = {
  /** Minute start (ms epoch, floor). */
  minuteStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Sum of TRADE tradeVolume only (deduped by eventId). */
  volume: number;
  tradeCount: number;
  /** True if any trade drop / gap was observed in this minute. */
  incomplete: boolean;
  updatedAtMs: number;
};

export type LatestQuote = {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  exchangeTsMs: number;
  receivedTsMs: number;
  eventId: string;
};

export type RiskSignal = {
  signalId: string;
  schemaVersion: "risk-signal.v1";
  kind: "ORDERBOOK_IMBALANCE" | "RETURN_SPIKE";
  market: "KR";
  symbol: string;
  observedAtMs: number;
  /** Observation only — never order-eligible. */
  orderEligible: false;
  details: Record<string, number | string | boolean>;
};

export type IngestMetrics = {
  enqueued: number;
  published: number;
  droppedQueue: number;
  droppedTrades: number;
  orderbookMerged: number;
  publishErrors: number;
  lastError?: string;
};
