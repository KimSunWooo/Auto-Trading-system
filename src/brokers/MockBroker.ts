import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import { findStock } from "@/lib/universe";
import type { OrderSource } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";
import {
  resolveMarketIntent,
  sellBandSlices,
} from "@/src/accounts/execution-policy";

/**
 * Local paper broker. Quotes come from the simulated book; fills go through
 * OrderManager so each user rule only spends its own sub-account.
 */
export class MockBroker implements IBroker {
  readonly driver = "mock" as const;

  constructor(
    private readonly box: StateBox,
    private readonly ruleKey: string = CASH_RULE_ID,
    private readonly source: OrderSource = "rule",
    private readonly sourceId?: string,
  ) {}

  forRule(ruleKey: string): MockBroker {
    return new MockBroker(this.box, ruleKey, this.source, this.sourceId);
  }

  withSource(source: OrderSource, sourceId?: string): MockBroker {
    return new MockBroker(this.box, this.ruleKey, source, this.sourceId);
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
    const last = await this.getCurrentPrice(ticker);
    const intent = resolveMarketIntent(ticker, "buy", last);
    const qty = Math.floor(amount / last);
    if (qty < 1) {
      const fill: BrokerFill = {
        ok: false,
        status: "rejected",
        ticker,
        side: "buy",
        qty: 0,
        price: last,
        amount: 0,
        net: 0,
        reason: "1주 미만이라 주문하지 않습니다.",
      };
      new OrderManager(this.box).observe(this.ruleKey, ticker, fill);
      return fill;
    }
    if (!canFillLimit("buy", last, intent.price)) {
      const fill: BrokerFill = {
        ok: false,
        status: "rejected",
        ticker,
        side: "buy",
        qty: 0,
        price: last,
        amount: 0,
        net: 0,
        reason: `지정가 ${intent.price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 높아 미체결입니다.`,
      };
      new OrderManager(this.box).observe(this.ruleKey, ticker, fill);
      return fill;
    }
    return new OrderManager(this.box).buy(this.ruleKey, ticker, qty, last, {
      source: this.source,
      sourceId: this.sourceId,
      ordDvsn: "limit",
    });
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    if (!canFillLimit("buy", last, price)) {
      const fill: BrokerFill = {
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
      new OrderManager(this.box).observe(this.ruleKey, ticker, fill);
      return fill;
    }
    const qty = Math.floor(amount / price);
    return new OrderManager(this.box).buy(this.ruleKey, ticker, qty, last, {
      source: this.source,
      sourceId: this.sourceId,
      ordDvsn: "limit",
    });
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    return sellBandSlices(this, ticker, qty, last);
  }

  async sellLimit(ticker: string, price: number, qty: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    if (!canFillLimit("sell", last, price)) {
      const fill: BrokerFill = {
        ok: false,
        status: "rejected",
        ticker,
        side: "sell",
        qty: 0,
        price: last,
        amount: 0,
        net: 0,
        reason: `지정가 ${price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 낮아 미체결입니다.`,
      };
      new OrderManager(this.box).observe(this.ruleKey, ticker, fill);
      return fill;
    }
    return new OrderManager(this.box).sell(this.ruleKey, ticker, qty, last, {
      source: this.source,
      sourceId: this.sourceId,
      ordDvsn: "limit",
    });
  }
}
