import type { KisClient, KisOverseasCancel } from "@/src/brokers/kis-client";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { overseasBuyCashGate, overseasOneShareEligibility } from "@/src/markets/overseas/preflight";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import {
  makeUsInstrument,
  parseOverseasInstrument,
  US_SEED_UNIVERSE,
  type OverseasInstrument,
  type UsExchange,
} from "@/src/markets/overseas/instruments";
import type {
  OverseasAccountSnapshot,
  OverseasBuyingPower,
  OverseasExecution,
  OverseasOpenOrder,
  OverseasQuote,
} from "@/src/markets/overseas/types";
import { findOrderByIntent, upsertIntent } from "@/src/runtime/intents";
import type { StateBox } from "@/src/accounts/StateBox";
import { RiskManager } from "@/src/risk/RiskManager";

export class OverseasTradingAdapter {
  constructor(private readonly client: KisClient) {}

  getQuote(instrument: OverseasInstrument): Promise<OverseasQuote> {
    return this.client.inquireOverseasPrice(instrument);
  }

  search(symbol: string, exchange?: UsExchange) {
    return this.client.searchOverseasInstrument(symbol, exchange);
  }

  getBalance(exchange?: UsExchange) {
    return this.client.inquireOverseasBalance(exchange);
  }

  getPresentBalance() {
    return this.client.inquireOverseasPresentBalance();
  }

  getBuyingPower(instrument: OverseasInstrument, price: number): Promise<OverseasBuyingPower> {
    return this.client.inquireOverseasPsamount(instrument, price);
  }

  getOpenOrders(exchange?: UsExchange): Promise<OverseasOpenOrder[]> {
    return this.client.inquireOverseasOpenOrders(exchange);
  }

  getExecutions(): Promise<OverseasExecution[]> {
    return this.client.inquireOverseasExecutions();
  }

  ordersLocked(env: NodeJS.ProcessEnv = process.env): string | null {
    return overseasPaperOrdersLocked(env);
  }

  async assembleAccount(symbol = "AAPL", exchange: UsExchange = "NASDAQ"): Promise<OverseasAccountSnapshot> {
    const instrument = makeUsInstrument(exchange, symbol);
    const present = await this.getPresentBalance();
    const { positions } = await this.getBalance(exchange);
    const usd = pickUsdCash(present.cash);
    let buyingPower = present.buyingPower;
    try {
      const last = (await this.getQuote(instrument)).price;
      buyingPower = await this.getBuyingPower(instrument, last);
    } catch {
      // keep present-balance orderable cash if psamount is unavailable
    }
    const fxRate = present.fx?.rate ?? usd?.exchangeRate ?? null;
    return {
      ...present,
      positions: positions.length ? positions : present.positions,
      buyingPower,
      cash: present.cash,
      fx: present.fx,
      estimatedKrwValue:
        present.estimatedKrwValue ??
        (usd && fxRate ? usd.cash * fxRate : present.estimatedKrwValue),
    };
  }

  /**
   * Same intent submits once. Timeout/UNKNOWN is left on the order; this method never blind-retries.
   * UI keeps BUY/SELL disabled until overseas PAPER opt-in is set.
   */
  async submitLimitOnce(
    box: StateBox,
    input: {
      intentId: string;
      signalId: string;
      instrument: OverseasInstrument;
      side: "buy" | "sell";
      qty: number;
      price: number;
      orderableUsd?: number | null;
      fxRate?: number | null;
    },
  ) {
    const locked = this.ordersLocked();
    if (locked) {
      return { ok: false as const, status: "rejected" as const, reason: locked, orderNo: undefined };
    }
    const identity = `${input.instrument.exchange}:${input.instrument.symbol}`;
    const existing = findOrderByIntent(box.current, input.intentId);
    if (existing) {
      return {
        ok: existing.status !== "rejected",
        status: existing.status,
        reason: existing.reason ?? "same intent already submitted",
        orderNo: existing.brokerOrderNo,
      };
    }
    const upserted = upsertIntent(box.current, {
      intentId: input.intentId,
      signalId: input.signalId,
      ruleId: "overseas",
      ticker: identity,
      side: input.side,
      qty: input.qty,
      price: input.price,
      reason: "overseas-limit",
    });
    box.current = upserted.state;
    if (upserted.duplicate) {
      return { ok: false as const, status: "rejected" as const, reason: "same intent already submitted", orderNo: upserted.intent.brokerOrderNo };
    }
    if (input.side === "buy") {
      const cashGate = overseasBuyCashGate(input.orderableUsd);
      if (!cashGate.ok) {
        return { ok: false as const, status: "rejected" as const, reason: cashGate.blocked, orderNo: undefined };
      }
      const risk = RiskManager.checkOverseasBuy({
        qty: input.qty,
        nativePrice: input.price,
        nativeCurrency: "USD",
        fxRate: input.fxRate,
        orderableNative: input.orderableUsd,
      });
      if (!risk.ok) {
        return { ok: false as const, status: "rejected" as const, reason: risk.reason, orderNo: undefined };
      }
      const instrument = overseasOneShareEligibility({
        symbol: input.instrument.symbol,
        nativePrice: input.price,
        usdOrderable: input.orderableUsd,
        fxRate: input.fxRate,
        qty: input.qty,
      });
      if (!instrument.eligible) {
        return { ok: false as const, status: "rejected" as const, reason: instrument.reason, orderNo: undefined };
      }
    }
    try {
      const placed = await this.client.orderOverseasUs({
        instrument: input.instrument,
        side: input.side,
        qty: input.qty,
        price: input.price,
      });
      return { ok: true as const, status: "pending" as const, reason: undefined, orderNo: placed.orderNo };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "해외 주문 실패";
      return { ok: false as const, status: "unknown" as const, reason, orderNo: undefined };
    }
  }

  async cancelExact(order: KisOverseasCancel) {
    const locked = this.ordersLocked();
    if (locked) throw new Error(locked);
    await this.client.cancelOverseasOrder(order);
  }
}

export function seedInstruments(): OverseasInstrument[] {
  return US_SEED_UNIVERSE.map((row) => makeUsInstrument(row.exchange, row.symbol, row.displayName));
}

export function parseOrSeed(query: string): OverseasInstrument | null {
  return parseOverseasInstrument(query);
}

export { KIS_CURRENCY_EXCHANGE_AUDIT };
