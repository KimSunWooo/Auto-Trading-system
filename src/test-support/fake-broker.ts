/**
 * Test-only local paper broker. NOT imported by production runtime.
 * Replaces deleted product MockBroker for unit tests of OrderManager / intent safety.
 */
import { OrderManager } from "@/src/accounts/OrderManager";
import { bookReportedFill } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill, BrokerQuote, IBroker, IntentMeta } from "@/src/brokers/IBroker";
import { canFillLimit } from "@/src/accounts/fills";
import type { OrderSource } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";
import {
  resolveMarketIntent,
  sellBandSlices,
} from "@/src/accounts/execution-policy";
import { findOrderByIntent } from "@/src/runtime/intents";

export type FakeBrokerMode =
  | "instant"
  | "delayed"
  | "reject"
  | "timeout"
  | "unknown"
  | "partial";

/** Test env: FAKE_BROKER_MODE preferred; MOCK_BROKER_MODE accepted for back-compat in tests only. */
export function fakeBrokerMode(
  env: Record<string, string | undefined> = process.env,
): FakeBrokerMode {
  const raw = String(env.FAKE_BROKER_MODE ?? env.MOCK_BROKER_MODE ?? "instant")
    .trim()
    .toLowerCase();
  if (
    raw === "delayed" ||
    raw === "reject" ||
    raw === "timeout" ||
    raw === "unknown" ||
    raw === "partial"
  ) {
    return raw;
  }
  return "instant";
}

/**
 * Local book filler for unit tests. driver reports "kis" so production
 * BrokerDriver union stays kis-only; this class must never ship in product paths.
 */
export class FakeBroker implements IBroker {
  readonly driver = "kis" as const;

  constructor(
    private readonly box: StateBox,
    private readonly ruleKey: string = CASH_RULE_ID,
    private readonly source: OrderSource = "rule",
    private readonly sourceId?: string,
    private readonly intent?: IntentMeta,
  ) {}

  forRule(ruleKey: string): FakeBroker {
    return new FakeBroker(this.box, ruleKey, this.source, this.sourceId, this.intent);
  }

  withSource(source: OrderSource, sourceId?: string): FakeBroker {
    return new FakeBroker(this.box, this.ruleKey, source, sourceId, this.intent);
  }

  withIntent(meta: IntentMeta): FakeBroker {
    return new FakeBroker(this.box, this.ruleKey, this.source, this.sourceId, meta);
  }

  async getQuote(ticker: string): Promise<BrokerQuote | null> {
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

  async getCurrentPrice(ticker: string): Promise<number> {
    const quote = await this.getQuote(ticker);
    if (!quote) throw new Error(`${ticker} 시세가 없습니다.`);
    return quote.price;
  }

  async buyMarket(ticker: string, amount: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    const intent = resolveMarketIntent(ticker, "buy", last);
    const qty = Math.floor(amount / last);
    if (qty < 1) {
      return this.reject(ticker, "buy", last, "1주 미만이라 주문하지 않습니다.");
    }
    if (!canFillLimit("buy", last, intent.price)) {
      return this.reject(
        ticker,
        "buy",
        last,
        `지정가 ${intent.price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 높아 미체결입니다.`,
      );
    }
    return this.execute("buy", ticker, qty, last);
  }

  async buyLimit(ticker: string, price: number, amount: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    if (!canFillLimit("buy", last, price)) {
      return this.reject(
        ticker,
        "buy",
        last,
        `지정가 ${price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 높아 미체결입니다.`,
      );
    }
    const qty = Math.floor(amount / price);
    return this.execute("buy", ticker, qty, last);
  }

  async sellMarket(ticker: string, qty: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    return sellBandSlices(this, ticker, qty, last);
  }

  async sellLimit(ticker: string, price: number, qty: number): Promise<BrokerFill> {
    const last = await this.getCurrentPrice(ticker);
    if (!canFillLimit("sell", last, price)) {
      return this.reject(
        ticker,
        "sell",
        last,
        `지정가 ${price.toLocaleString("ko-KR")}원보다 현재가 ${last.toLocaleString("ko-KR")}원이 낮아 미체결입니다.`,
      );
    }
    return this.execute("sell", ticker, qty, last);
  }

  private execute(side: "buy" | "sell", ticker: string, qty: number, price: number): BrokerFill {
    const orders = new OrderManager(this.box);
    const intentId = this.intent?.intentId;
    if (intentId) {
      const existing = findOrderByIntent(this.box.current, intentId);
      if (existing) return orders.toFill(existing);
    }
    const opts = {
      source: this.source,
      sourceId: this.sourceId,
      ordDvsn: "limit" as const,
      intentId,
      liquidation: this.box.current.settings.liquidating,
    };
    const gate =
      side === "buy"
        ? orders.canBuy(this.ruleKey, qty, price, ticker)
        : orders.canSell(this.ruleKey, ticker, qty, {
            liquidation: this.box.current.settings.liquidating,
          });
    if (!gate.ok) return orders.gateReject(this.ruleKey, ticker, side, gate.reason);
    const mode = fakeBrokerMode();
    if (mode === "reject") {
      return orders.gateReject(this.ruleKey, ticker, side, "FAKE reject");
    }
    if (mode === "timeout" || mode === "unknown") {
      const pending = orders.begin(this.ruleKey, ticker, side, qty, price, opts);
      if (pending.brokerOrderNo || pending.status === "unknown" || pending.status === "filled") {
        return orders.toFill(pending);
      }
      return orders.unknown(
        pending.id,
        mode === "timeout" ? "주문 응답 시간 초과" : "FAKE unknown",
      );
    }
    if (mode === "delayed") {
      const pending = orders.begin(this.ruleKey, ticker, side, qty, price, opts);
      if (pending.brokerOrderNo || pending.status === "unknown" || pending.status === "filled") {
        return orders.toFill(pending);
      }
      return orders.ackWorking(pending.id, `FAKE-${pending.id}`, "지연 체결 시뮬 · 접수만 반영");
    }
    if (mode === "partial") {
      const pending = orders.begin(this.ruleKey, ticker, side, qty, price, opts);
      if (pending.brokerOrderNo || pending.status === "unknown" || pending.status === "filled") {
        return orders.toFill(pending);
      }
      orders.ackWorking(pending.id, `FAKE-${pending.id}`, "부분체결 시뮬");
      const half = Math.max(1, Math.floor(qty / 2));
      const booked = bookReportedFill(this.box.current, pending.id, {
        filledQty: Math.min(half, qty),
        avgPrice: price,
        brokerOrderNo: `FAKE-${pending.id}`,
      });
      this.box.current = booked.state;
      const live = this.box.current.orders.find((row) => row.id === pending.id) ?? booked.parent;
      return orders.toFill(live);
    }
    return side === "buy"
      ? orders.buy(this.ruleKey, ticker, qty, price, opts)
      : orders.sell(this.ruleKey, ticker, qty, price, opts);
  }

  private reject(ticker: string, side: "buy" | "sell", price: number, reason: string): BrokerFill {
    const fill: BrokerFill = {
      ok: false,
      status: "rejected",
      ticker,
      side,
      qty: 0,
      price,
      amount: 0,
      net: 0,
      reason,
    };
    new OrderManager(this.box).observe(this.ruleKey, ticker, fill);
    return fill;
  }
}

/** @deprecated Use FakeBroker — alias for gradual test migration. */
export const MockBroker = FakeBroker;
