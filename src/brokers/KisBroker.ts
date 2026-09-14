import type { BrokerFill, BrokerQuote, IBroker } from "@/src/brokers/IBroker";

export type KisBrokerConfig = {
  appKey?: string;
  appSecret?: string;
  accountNo?: string;
  /** KIS paper account vs live. */
  mode?: "demo" | "real";
};

const NOT_WIRED =
  "KisBroker는 아직 Open API에 연결되지 않았습니다. BROKER=mock 으로 모의체결을 사용하세요.";

/**
 * Skeleton for 한국투자증권 Open API.
 * Real REST auth/token/order endpoints belong here later — strategies stay unchanged.
 */
export class KisBroker implements IBroker {
  readonly driver = "kis" as const;

  constructor(private readonly config: KisBrokerConfig = {}) {}

  configured(): boolean {
    return Boolean(this.config.appKey && this.config.appSecret && this.config.accountNo);
  }

  async getQuote(ticker: string): Promise<BrokerQuote | null> {
    throw new Error(`${NOT_WIRED} (getQuote ${ticker})`);
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    throw new Error(`${NOT_WIRED} (getCurrentPrice ${ticker})`);
  }

  async buyMarket(ticker: string, amount: number): Promise<BrokerFill> {
    return this.unwired(ticker, "buy", amount);
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    return this.unwired(ticker, "buy", amount, price);
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    return {
      ok: false,
      ticker,
      side: "sell",
      qty,
      price: 0,
      amount: 0,
      net: 0,
      reason: NOT_WIRED,
    };
  }

  private unwired(
    ticker: string,
    side: "buy" | "sell",
    amount: number,
    price = 0,
  ): BrokerFill {
    return {
      ok: false,
      ticker,
      side,
      qty: 0,
      price,
      amount,
      net: 0,
      reason: NOT_WIRED,
    };
  }
}
