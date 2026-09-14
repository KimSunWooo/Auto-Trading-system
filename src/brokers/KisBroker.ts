import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import type { KisApi } from "@/src/brokers/kis-client";
import { findStock } from "@/lib/universe";
import { tickSize } from "@/lib/tick-size";
import type { OrderSource, Quote } from "@/lib/types";
import { isIndeterminateError } from "@/src/risk/errors";
import { tradingBlocked } from "@/src/risk/circuit";
import { settleOpenOrders } from "@/src/risk/reconcile";

/**
 * 한국투자증권 Open API adapter.
 * 주문은 pending 기록 후 전송하고, ODNO는 접수로만 취급합니다.
 * 실제 체결 수량은 일별 체결내역으로만 장부에 넣고, 잔량은 일정 시간 후 취소합니다.
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
    } catch (err) {
      return this.fail(ticker, "buy", err);
    }
    return this.placeBuy(ticker, amount, "limit", price);
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    return this.placeSell(ticker, qty);
  }

  private async placeBuy(
    ticker: string,
    amount: number,
    ordDvsn: "market" | "limit",
    limitPrice?: number,
  ): Promise<BrokerFill> {
    const blocked = this.precheck(ticker, "buy");
    if (blocked) return blocked;

    let price = 0;
    const orders = new OrderManager(this.box);
    try {
      price = ordDvsn === "limit" && limitPrice ? limitPrice : await this.getCurrentPrice(ticker);
      const qty = Math.floor(amount / price);
      const gate = orders.canBuy(this.strategyKey, qty, price, ticker);
      if (!gate.ok) return this.reject(ticker, "buy", gate.reason);
      const pending = orders.begin(this.strategyKey, ticker, "buy", qty, price, {
        source: this.source,
        sourceId: this.sourceId,
      });
      await persistNow(this.box.current);
      try {
        const placed = await this.client.orderCash({
          ticker,
          side: "buy",
          qty,
          ordDvsn,
          price: ordDvsn === "limit" ? price : 0,
        });
        const working = orders.ackWorking(
          pending.id,
          placed.orderNo,
          `주문 접수(${placed.orderNo}). 체결수량은 체결내역으로만 반영합니다.`,
          { krxOrgNo: placed.krxOrgNo, ordDvsn },
        );
        await persistNow(this.box.current);
        await settleOpenOrders(this.box, this.client);
        await persistNow(this.box.current);
        const latest = this.box.current.orders.find((row) => row.id === pending.id);
        return latest ? orders.toFill(latest) : working;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "한국투자증권 주문에 실패했습니다.";
        if (isIndeterminateError(err)) {
          return orders.unknown(pending.id, reason);
        }
        return orders.rejectRemote(pending.id, reason);
      }
    } catch (err) {
      return this.fail(ticker, "buy", err, price);
    }
  }

  private async placeSell(ticker: string, qty: number): Promise<BrokerFill> {
    const blocked = this.precheck(ticker, "sell");
    if (blocked) return blocked;

    const orders = new OrderManager(this.box);
    const gate = orders.canSell(this.strategyKey, ticker, qty);
    if (!gate.ok) return this.reject(ticker, "sell", gate.reason);

    let price = 0;
    try {
      price = await this.getCurrentPrice(ticker);
      const pending = orders.begin(this.strategyKey, ticker, "sell", qty, price, {
        source: this.source,
        sourceId: this.sourceId,
      });
      await persistNow(this.box.current);
      try {
        const placed = await this.client.orderCash({
          ticker,
          side: "sell",
          qty,
          ordDvsn: "market",
          price: 0,
        });
        const working = orders.ackWorking(
          pending.id,
          placed.orderNo,
          `주문 접수(${placed.orderNo}). 체결수량은 체결내역으로만 반영합니다.`,
          { krxOrgNo: placed.krxOrgNo, ordDvsn: "market" },
        );
        await persistNow(this.box.current);
        await settleOpenOrders(this.box, this.client);
        await persistNow(this.box.current);
        const latest = this.box.current.orders.find((row) => row.id === pending.id);
        return latest ? orders.toFill(latest) : working;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "한국투자증권 주문에 실패했습니다.";
        if (isIndeterminateError(err)) {
          return orders.unknown(pending.id, reason);
        }
        return orders.rejectRemote(pending.id, reason);
      }
    } catch (err) {
      return this.fail(ticker, "sell", err, price);
    }
  }

  private precheck(ticker: string, side: "buy" | "sell"): BrokerFill | null {
    if (!this.client.configured) {
      return this.reject(
        ticker,
        side,
        this.client.issues[0] ?? "한국투자증권 앱키가 설정되지 않았습니다.",
      );
    }
    if (!this.client.liveEnabled) {
      return this.reject(
        ticker,
        side,
        "실전 주문이 잠겨 있습니다. KIS_LIVE_CONFIRM=I_UNDERSTAND 를 설정하세요.",
      );
    }
    const halted = tradingBlocked(this.box.current);
    if (halted) return this.reject(ticker, side, halted);
    return null;
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
      status: "rejected",
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
      status: "rejected",
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

async function persistNow(state: import("@/lib/types").AppState) {
  const { persistStateNow } = await import("@/lib/store");
  await persistStateNow(state);
}
