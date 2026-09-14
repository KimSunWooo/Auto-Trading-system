import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import { findStock } from "@/lib/universe";
import type { OrderSource } from "@/lib/types";

/**
 * Local paper broker. Quotes come from the simulated book; fills go through
 * OrderManager so each strategy only spends its own sub-account.
 */
export class MockBroker implements IBroker {
  readonly driver = "mock" as const;

  constructor(
    private readonly box: StateBox,
    private readonly strategyKey: string = "Level1_Stable",
    private readonly source: OrderSource = "strategy",
    private readonly sourceId?: string,
  ) {}

  forStrategy(strategyKey: string): MockBroker {
    return new MockBroker(this.box, strategyKey, this.source, this.sourceId);
  }

  withSource(source: OrderSource, sourceId?: string): MockBroker {
    return new MockBroker(this.box, this.strategyKey, source, sourceId);
  }

  async getQuote(ticker: string): Promise<BrokerQuote | null> {
    const quote = this.box.current.quotes[ticker];
    const stock = findStock(ticker);
    if (!quote && !stock) return null;
    if (!quote) return null;
    return {
      ticker: quote.code,
      name: quote.name,
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      volume: quote.volume,
      history: quote.history,
    };
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    const quote = await this.getQuote(ticker);
    if (!quote) {
      throw new Error(`${ticker} 시세가 없습니다.`);
    }
    return quote.price;
  }

  async buyMarket(ticker: string, amount: number): Promise<BrokerFill> {
    const price = await this.getCurrentPrice(ticker);
    const qty = Math.floor(amount / price);
    return new OrderManager(this.box).buy(this.strategyKey, ticker, qty, price, {
      source: this.source,
      sourceId: this.sourceId,
    });
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    if (!canFillLimit("buy", last, price)) {
      return {
        ok: false,
        status: "rejected",
        ticker,
        side: "buy",
        qty: 0,
        price: last,
        amount: 0,
        net: 0,
        reason: `지정가 ${price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 높아 미체결입니다.`,
      };
    }
    const qty = Math.floor(amount / price);
    return new OrderManager(this.box).buy(this.strategyKey, ticker, qty, price, {
      source: this.source,
      sourceId: this.sourceId,
    });
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    const price = await this.getCurrentPrice(ticker);
    return new OrderManager(this.box).sell(this.strategyKey, ticker, qty, price, {
      source: this.source,
      sourceId: this.sourceId,
    });
  }
}
