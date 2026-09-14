import type { OrderSource } from "@/lib/types";

/**
 * Broker adapter contract.
 *
 * MockBroker fills the local paper book. KisBroker talks to 한국투자증권
 * Open API (모의 VTS / 실전) then mirrors the fill onto the local risk buckets.
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
  readonly driver: "mock" | "kis";
  forStrategy(strategyKey: string): IBroker;
  withSource(source: OrderSource, sourceId?: string): IBroker;
  getCurrentPrice(ticker: string): Promise<number>;
  getQuote(ticker: string): Promise<BrokerQuote | null>;
  buyMarket(ticker: string, amount: number): Promise<BrokerFill>;
  buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill>;
  sellMarket(ticker: string, qty: number): Promise<BrokerFill>;
}
