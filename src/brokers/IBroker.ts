import type { OrderSource, OrderStatus } from "@/lib/types";

export type IntentMeta = {
  intentId: string;
  signalId?: string;
  reason?: string;
};

/**
 * Broker adapter contract.
 *
 * KisBroker talks to 한국투자증권 Open API (모의 VTS / 실전),
 * keeps the ticket pending until daily ccld reports filled qty,
 * then mirrors only that qty onto the local risk buckets.
 * Production never uses a local mock book.
 */
export interface BrokerQuote {
  ticker: string;
  name: string;
  price: number;
  bid: number;
  ask: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  history: number[];
}

export interface BrokerFill {
  ok: boolean;
  status: OrderStatus;
  orderId?: string;
  ticker: string;
  name?: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  amount: number;
  net: number;
  reason?: string;
}

export interface IBroker {
  readonly driver: "kis";
  forRule(ruleKey: string): IBroker;
  withSource(source: OrderSource, sourceId?: string): IBroker;
  withIntent(meta: IntentMeta): IBroker;
  getCurrentPrice(ticker: string): Promise<number>;
  getQuote(ticker: string): Promise<BrokerQuote | null>;
  buyMarket(ticker: string, amount: number): Promise<BrokerFill>;
  buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill>;
  sellMarket(ticker: string, qty: number): Promise<BrokerFill>;
  sellLimit(ticker: string, price: number, qty: number): Promise<BrokerFill>;
}
