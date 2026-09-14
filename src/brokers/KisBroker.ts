import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import type { KisApi } from "@/src/brokers/kis-client";
import { findStock } from "@/lib/universe";
import { tickSize } from "@/lib/tick-size";
import type { OrderSource, Quote } from "@/lib/types";

/**
 * 한국투자증권 Open API adapter.
 * 시세는 조회 API, 주문은 현금 주문 API로 보낸 뒤 로컬 리스크 버킷에 반영합니다.
 */
export class KisBroker implements IBroker {
  readonly driver = "kis" as const;

  constructor(
    private readonly box: StateBox,
    private readonly client: KisApi,
    private readonly strategyKey: string = "Level1_Stable",
    private readonly source: OrderSource = "strategy",
    private readonly sourceId?: string,
  ) {}

  forStrategy(strategyKey: string): KisBroker {
    return new KisBroker(this.box, this.client, strategyKey, this.source, this.sourceId);
  }

  withSource(source: OrderSource, sourceId?: string): KisBroker {
    return new KisBroker(this.box, this.client, this.strategyKey, source, sourceId);
  }

  async getQuote(ticker: string): Promise<BrokerQuote | null> {
    if (!this.client.configured) return this.fromBook(ticker);
    try {
      const [live, daily] = await Promise.all([
        this.client.inquirePrice(ticker),
        this.client.inquireDailyCloses(ticker),
      ]);
      const stock = findStock(ticker);
      const prev = this.box.current.quotes[ticker];
      const tick = tickSize(live.price);
      const history =
        daily.length > 0
          ? [...daily.slice(-39), live.price]
          : [...(prev?.history ?? []), live.price].slice(-40);
      const quote: BrokerQuote = {
        ticker,
        name: live.name || prev?.name || stock?.name || ticker,
        price: live.price,
        bid: Math.max(tick, live.price - tick),
        ask: live.price + tick,
        open: live.open,
        high: live.high,
        low: live.low,
        prevClose: live.prevClose,
        volume: live.volume,
        history,
      };
      this.remember(quote);
      return quote;
    } catch {
      return this.fromBook(ticker);
    }
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    const quote = await this.getQuote(ticker);
    if (!quote) {
      throw new Error(`${ticker} 시세를 한국투자증권에서 가져오지 못했습니다.`);
    }
    return quote.price;
  }

  async buyMarket(ticker: string, amount: number): Promise<BrokerFill> {
    return this.placeBuy(ticker, amount, "market");
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    try {
      const last = await this.getCurrentPrice(ticker);
      if (!canFillLimit("buy", last, price)) {
        return {
          ok: false,
          ticker,
          side: "buy",
          qty: 0,
          price: last,
          amount: 0,
          net: 0,
          reason: `지정가 ${price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 높아 미체결입니다.`,
        };
      }
    } catch (err) {
      return this.fail(ticker, "buy", err);
    }
    return this.placeBuy(ticker, amount, "limit", price);
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    if (!this.client.configured) {
      return this.reject(
        ticker,
        "sell",
        this.client.issues[0] ?? "한국투자증권 앱키가 설정되지 않았습니다.",
      );
    }
    if (!this.client.liveEnabled) {
      return this.reject(
        ticker,
        "sell",
        "실전 주문이 잠겨 있습니다. KIS_LIVE_CONFIRM=I_UNDERSTAND 를 설정하세요.",
      );
    }

    const orders = new OrderManager(this.box);
    const blocked = orders.canSell(this.strategyKey, ticker, qty);
    if (!blocked.ok) {
      return this.reject(ticker, "sell", blocked.reason);
    }

    let price = 0;
    try {
      price = await this.getCurrentPrice(ticker);
      const placed = await this.client.orderCash({
        ticker,
        side: "sell",
        qty,
        ordDvsn: "market",
        price: 0,
      });
      return orders.sell(this.strategyKey, ticker, qty, price, {
        source: this.source,
        sourceId: this.sourceId,
        orderId: placed.orderNo,
      });
    } catch (err) {
      return this.fail(ticker, "sell", err, price);
    }
  }

  private async placeBuy(
    ticker: string,
    amount: number,
    ordDvsn: "market" | "limit",
    limitPrice?: number,
  ): Promise<BrokerFill> {
    if (!this.client.configured) {
      return this.reject(
        ticker,
        "buy",
        this.client.issues[0] ?? "한국투자증권 앱키가 설정되지 않았습니다.",
      );
    }
    if (!this.client.liveEnabled) {
      return this.reject(
        ticker,
        "buy",
        "실전 주문이 잠겨 있습니다. KIS_LIVE_CONFIRM=I_UNDERSTAND 를 설정하세요.",
      );
    }

    let price = 0;
    try {
      price = ordDvsn === "limit" && limitPrice ? limitPrice : await this.getCurrentPrice(ticker);
      const qty = Math.floor(amount / price);
      const orders = new OrderManager(this.box);
      const gate = orders.canBuy(this.strategyKey, qty, price);
      if (!gate.ok) {
        return this.reject(ticker, "buy", gate.reason);
      }
      const placed = await this.client.orderCash({
        ticker,
        side: "buy",
        qty,
        ordDvsn,
        price: ordDvsn === "limit" ? price : 0,
      });
      return orders.buy(this.strategyKey, ticker, qty, price, {
        source: this.source,
        sourceId: this.sourceId,
        orderId: placed.orderNo,
      });
    } catch (err) {
      return this.fail(ticker, "buy", err, price);
    }
  }

  private fromBook(ticker: string): BrokerQuote | null {
    const quote = this.box.current.quotes[ticker];
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

  private remember(quote: BrokerQuote) {
    const prev = this.box.current.quotes[quote.ticker];
    const next: Quote = {
      code: quote.ticker,
      name: quote.name,
      market: prev?.market ?? "KOSPI",
      price: quote.price,
      prevClose: quote.prevClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      volume: quote.volume,
      bid: quote.bid,
      ask: quote.ask,
      history: quote.history,
    };
    this.box.current = {
      ...this.box.current,
      quotes: { ...this.box.current.quotes, [quote.ticker]: next },
    };
  }

  private reject(ticker: string, side: "buy" | "sell", reason: string): BrokerFill {
    return {
      ok: false,
      ticker,
      side,
      qty: 0,
      price: 0,
      amount: 0,
      net: 0,
      reason,
    };
  }

  private fail(
    ticker: string,
    side: "buy" | "sell",
    err: unknown,
    price = 0,
  ): BrokerFill {
    return {
      ok: false,
      ticker,
      side,
      qty: 0,
      price,
      amount: 0,
      net: 0,
      reason: err instanceof Error ? err.message : "한국투자증권 주문에 실패했습니다.",
    };
  }
}
