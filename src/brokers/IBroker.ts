/**
 * Broker adapter contract.
 *
 * MockBroker fills the local paper book. KisBroker is the future KIS Open API
 * adapter — swap via `createBroker()` without changing strategies.
 *
 * `amount` on buy methods is notional KRW (정액). `qty` on sell is shares.
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
  getCurrentPrice(ticker: string): Promise<number>;
  getQuote(ticker: string): Promise<BrokerQuote | null>;
  buyMarket(ticker: string, amount: number): Promise<BrokerFill>;
  buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill>;
  sellMarket(ticker: string, qty: number): Promise<BrokerFill>;
}
