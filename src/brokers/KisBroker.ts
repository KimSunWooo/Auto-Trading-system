import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker, IntentMeta } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import { KisClient, type KisApi } from "@/src/brokers/kis-client";
import { findStock } from "@/lib/universe";
import { tickSize } from "@/lib/tick-size";
import type { OrderSource, Quote } from "@/lib/types";
import { isIndeterminateError, BrokerRejectError } from "@/src/risk/errors";
import { tradingBlocked } from "@/src/risk/circuit";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { refreshBrokerBalanceSnapshot } from "@/src/risk/balance-sync";
import { CASH_RULE_ID } from "@/src/rules/params";
import { executionLocked } from "@/src/rules/disclaimer";
import {
  resolveMarketIntent,
  sellBandSlices,
  sessionBlockReason,
} from "@/src/accounts/execution-policy";
import { isLiveLike, liveOrdersLocked, tradingMode } from "@/src/runtime/trading-mode";
import { findOrderByIntent } from "@/src/runtime/intents";
import { nowMs } from "@/src/clock";
import { blockSafety } from "@/src/runtime/safety";
import { holdsWorkerLock } from "@/src/runtime/worker-lock";

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
    private readonly ruleKey: string = CASH_RULE_ID,
    private readonly source: OrderSource = "rule",
    private readonly sourceId?: string,
    private readonly intent?: IntentMeta,
  ) {}

  forRule(ruleKey: string): KisBroker {
    return new KisBroker(this.box, this.client, ruleKey, this.source, this.sourceId, this.intent);
  }

  withSource(source: OrderSource, sourceId?: string): KisBroker {
    return new KisBroker(this.box, this.client, this.ruleKey, source, sourceId, this.intent);
  }

  withIntent(meta: IntentMeta): KisBroker {
    return new KisBroker(this.box, this.client, this.ruleKey, this.source, this.sourceId, meta);
  }

  async getQuote(ticker: string): Promise<BrokerQuote | null> {
    if (!this.client.configured) {
      if (isLiveLike()) return null;
      return this.fromBook(ticker);
    }
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
    } catch (err) {
      if (isLiveLike()) {
        const reason = err instanceof Error ? err.message : "KIS 시세 조회 실패";
        this.box.current = blockSafety(this.box.current, "market_data_unavailable", reason, {
          quoteOk: false,
        });
        return null;
      }
      return this.fromBook(ticker);
    }
  }

  async getCurrentPrice(ticker: string): Promise<number> {
    const quote = await this.getQuote(ticker);
    if (!quote) {
      throw new Error(`${ticker} 시세를 한국투자증권에서 가져오지 못했습니다.`);
    }
    if (isLiveLike()) {
      const book = this.box.current.quotes[ticker];
      if (book?.source !== "kis" || !book.freshAt || nowMs() - book.freshAt > 15_000) {
        throw new Error(`${ticker} 실시간 시세가 없어 주문하지 않습니다.`);
      }
    }
    return quote.price;
  }

  private overseasClient(): KisClient {
    if (!(this.client instanceof KisClient)) {
      throw new Error("해외주식 API는 KisClient 가 필요합니다.");
    }
    return this.client;
  }

  async getOverseasQuote(instrument: import("@/src/markets/overseas/instruments").OverseasInstrument) {
    return this.overseasClient().inquireOverseasPrice(instrument);
  }

  async getOverseasBalance(exchange?: import("@/src/markets/overseas/instruments").UsExchange) {
    return this.overseasClient().inquireOverseasBalance(exchange);
  }

  async getOverseasPositions(exchange?: import("@/src/markets/overseas/instruments").UsExchange) {
    const { positions } = await this.overseasClient().inquireOverseasBalance(exchange);
    return positions;
  }

  async getOverseasOpenOrders(exchange?: import("@/src/markets/overseas/instruments").UsExchange) {
    return this.overseasClient().inquireOverseasOpenOrders(exchange);
  }

  async getOverseasExecutions() {
    return this.overseasClient().inquireOverseasExecutions();
  }

  async buyMarket(ticker: string, amount: number): Promise<BrokerFill> {
    const existing = this.peekIntent();
    if (existing) return existing;
    try {
      const last = await this.getCurrentPrice(ticker);
      const intent = resolveMarketIntent(ticker, "buy", last);
      const qty = Math.floor(amount / last);
      return this.placeBuy(ticker, amount, "limit", intent.price, qty);
    } catch (err) {
      return this.fail(ticker, "buy", err);
    }
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    try {
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
    } catch (err) {
      return this.fail(ticker, "buy", err);
    }
    return this.placeBuy(ticker, amount, "limit", price);
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    const existing = this.peekIntent();
    if (existing) return existing;
    const blocked = this.precheck(ticker, "sell");
    if (blocked) return blocked;
    try {
      const last = await this.getCurrentPrice(ticker);
      return sellBandSlices(this, ticker, qty, last);
    } catch (err) {
      return this.fail(ticker, "sell", err);
    }
  }

  async sellLimit(ticker: string, price: number, qty: number): Promise<BrokerFill> {
    return this.placeSell(ticker, qty, "limit", price);
  }

  private async placeBuy(
    ticker: string,
    amount: number,
    ordDvsn: "market" | "limit",
    limitPrice?: number,
    qtyOverride?: number,
  ): Promise<BrokerFill> {
    const orders = new OrderManager(this.box);
    const existing = this.existingIntentFill(orders);
    if (existing) return existing;
    const blocked = this.precheck(ticker, "buy");
    if (blocked) return blocked;
    let price = 0;
    try {
      const last = await this.getCurrentPrice(ticker);
      price = ordDvsn === "limit" && limitPrice ? limitPrice : last;
      const qty = qtyOverride ?? Math.floor(amount / (limitPrice && limitPrice > 0 ? limitPrice : last));
      const gate = orders.canBuy(this.ruleKey, qty, last, ticker);
      if (!gate.ok) return orders.gateReject(this.ruleKey, ticker, "buy", gate.reason);
      const pending = orders.begin(this.ruleKey, ticker, "buy", qty, price, {
        source: this.source,
        sourceId: this.sourceId,
        ordDvsn,
        intentId: this.intent?.intentId,
      });
      if (
        pending.brokerOrderNo ||
        pending.status === "unknown" ||
        pending.status === "filled" ||
        pending.status === "rejected"
      ) {
        return orders.toFill(pending);
      }
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
        await refreshBrokerBalanceSnapshot(this.box, this.client);
        await persistNow(this.box.current);
        const latest = this.box.current.orders.find((row) => row.id === pending.id);
        return latest ? orders.toFill(latest) : working;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "한국투자증권 주문에 실패했습니다.";
        if (err instanceof BrokerRejectError && !isIndeterminateError(err)) {
          return orders.rejectRemote(pending.id, reason);
        }
        return orders.unknown(pending.id, reason);
      }
    } catch (err) {
      return this.fail(ticker, "buy", err, price);
    }
  }

  private async placeSell(
    ticker: string,
    qty: number,
    ordDvsn: "market" | "limit" = "market",
    limitPrice?: number,
  ): Promise<BrokerFill> {
    const orders = new OrderManager(this.box);
    const existing = this.existingIntentFill(orders);
    if (existing) return existing;
    const blocked = this.precheck(ticker, "sell");
    if (blocked) return blocked;
    const gate = orders.canSell(this.ruleKey, ticker, qty, {
      liquidation: this.box.current.settings.liquidating,
    });
    if (!gate.ok) return orders.gateReject(this.ruleKey, ticker, "sell", gate.reason);

    let price = 0;
    try {
      price = ordDvsn === "limit" && limitPrice ? limitPrice : await this.getCurrentPrice(ticker);
      const pending = orders.begin(this.ruleKey, ticker, "sell", qty, price, {
        source: this.source,
        sourceId: this.sourceId,
        ordDvsn,
        intentId: this.intent?.intentId,
      });
      if (
        pending.brokerOrderNo ||
        pending.status === "unknown" ||
        pending.status === "filled" ||
        pending.status === "rejected"
      ) {
        return orders.toFill(pending);
      }
      await persistNow(this.box.current);
      try {
        const placed = await this.client.orderCash({
          ticker,
          side: "sell",
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
        await refreshBrokerBalanceSnapshot(this.box, this.client);
        await persistNow(this.box.current);
        const latest = this.box.current.orders.find((row) => row.id === pending.id);
        return latest ? orders.toFill(latest) : working;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "한국투자증권 주문에 실패했습니다.";
        if (err instanceof BrokerRejectError && !isIndeterminateError(err)) {
          return orders.rejectRemote(pending.id, reason);
        }
        return orders.unknown(pending.id, reason);
      }
    } catch (err) {
      return this.fail(ticker, "sell", err, price);
    }
  }

  private precheck(ticker: string, side: "buy" | "sell"): BrokerFill | null {
    const liveLock = liveOrdersLocked();
    if (liveLock) return this.reject(ticker, side, liveLock);
    if (this.client.mode === "real" && tradingMode() !== "live") {
      return this.reject(
        ticker,
        side,
        "LIVE_TEST/MOCK에서는 KIS 모의투자(VTS)만 주문합니다. KIS_MODE=paper 와 KIS_PAPER_* 를 사용하세요.",
      );
    }
    if (this.client.mode === "real") {
      if (!this.client.configured) {
        return this.reject(
          ticker,
          side,
          this.client.issues[0] ?? "REAL credential 이 없습니다. 주문하지 않습니다.",
        );
      }
      if (!this.client.cano?.trim()) {
        return this.reject(ticker, side, "REAL 계좌번호가 없습니다. 주문하지 않습니다.");
      }
    }
    const liquidatingSell = this.box.current.settings.liquidating && side === "sell";
    if (isLiveLike() && !holdsWorkerLock() && !liquidatingSell) {
      return this.reject(ticker, side, "트레이딩 워커 락이 없어 주문하지 않습니다.");
    }
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
        this.client.mode === "real"
          ? "실전 주문이 잠겨 있습니다. TRADING_MODE=live, ALLOW_LIVE_TRADING=true, KIS_LIVE_CONFIRM=I_UNDERSTAND 가 모두 필요합니다."
          : "한국투자증권 주문이 잠겨 있습니다.",
      );
    }
    const locked = executionLocked(this.box.current);
    if (locked && !(this.box.current.settings.liquidating && side === "sell")) {
      return this.reject(ticker, side, locked);
    }
    if (this.box.current.settings.liquidating && side === "buy") {
      return this.reject(ticker, side, "긴급 정지로 신규 매수를 막았습니다.");
    }
    const hours = sessionBlockReason(this.box.current, undefined, { forceRegularSession: true });
    if (hours) return this.reject(ticker, side, hours);
    if (this.box.current.settings.liquidating && side === "sell") {
      return null;
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
      source: "kis",
      freshAt: nowMs(),
    };
    this.box.current = {
      ...this.box.current,
      quotes: { ...this.box.current.quotes, [quote.ticker]: next },
    };
  }

  private peekIntent(): BrokerFill | null {
    return this.existingIntentFill(new OrderManager(this.box));
  }

  private existingIntentFill(orders: OrderManager): BrokerFill | null {
    const intentId = this.intent?.intentId;
    if (!intentId) return null;
    const existing = findOrderByIntent(this.box.current, intentId);
    if (!existing) return null;
    return orders.toFill(existing);
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
