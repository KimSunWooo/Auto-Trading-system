import type { KisOverseasApi, KisOverseasCancel } from "@/src/brokers/kis-client";
import { BrokerRejectError, isIndeterminateError } from "@/src/risk/errors";
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
import {
  overseasCancelAllowed,
  overseasFirstLifecycleQtyOk,
  overseasSellQtyAllowed,
} from "@/src/markets/overseas/lifecycle";
import { parseOverseasLimitPrice } from "@/src/markets/overseas/price";
import type { OverseasAccountSnapshot, OverseasBuyingPower, OverseasExecution, OverseasOpenOrder, OverseasQuote } from "@/src/markets/overseas/types";
import {
  collectAllExchangeOpenOrders,
  collectAllExchangePositions,
} from "@/src/markets/overseas/exchange-coverage";
import { findIntent, findOrderByIntent, patchIntent, upsertIntent } from "@/src/runtime/intents";
import type { StateBox } from "@/src/accounts/StateBox";
import { checkPaperOrderConstraints, existingOpenBuy, usesPaperOrderPolicy } from "@/src/risk/order-policy";
import { RiskManager } from "@/src/risk/RiskManager";

async function persistNow(state: import("@/lib/types").AppState) {
  const { persistStateNow } = await import("@/lib/store");
  await persistStateNow(state);
}

export class OverseasTradingAdapter {
  constructor(private readonly client: KisOverseasApi) {}

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

  /** NASDAQ + NYSE + AMEX open orders, de-duplicated by ODNO. */
  async getAllOpenOrders(): Promise<{
    orders: OverseasOpenOrder[];
    probes: Awaited<ReturnType<typeof collectAllExchangeOpenOrders>>["probes"];
  }> {
    return collectAllExchangeOpenOrders((exchange) => this.getOpenOrders(exchange));
  }

  getExecutions(): Promise<OverseasExecution[]> {
    return this.client.inquireOverseasExecutions();
  }

  /** NASDAQ + NYSE + AMEX positions, merged by EXCHANGE:SYMBOL identity. */
  async getAllPositions(): Promise<{
    positions: Awaited<ReturnType<typeof collectAllExchangePositions>>["positions"];
    probes: Awaited<ReturnType<typeof collectAllExchangePositions>>["probes"];
  }> {
    return collectAllExchangePositions(async (exchange) => {
      const { positions } = await this.getBalance(exchange);
      return positions;
    });
  }

  ordersLocked(env: NodeJS.ProcessEnv = process.env): string | null {
    return overseasPaperOrdersLocked(env);
  }

  /**
   * Fresh buying-power authority: prefer inquire-psamount; fall back to present-balance orderable.
   * Stale cached values alone must not authorize a BUY.
   */
  async resolveFreshBuyingPower(
    instrument: OverseasInstrument,
    price: number,
  ): Promise<OverseasBuyingPower> {
    try {
      return await this.getBuyingPower(instrument, price);
    } catch {
      const present = await this.getPresentBalance();
      const usd = pickUsdCash(present.cash);
      return (
        present.buyingPower ?? {
          currency: "USD",
          orderableCash: usd?.orderableCash ?? 0,
          orderableQty: 0,
          exchange: instrument.exchange,
          symbol: instrument.symbol,
        }
      );
    }
  }

  async assembleAccount(symbol = "AAPL", exchange: UsExchange = "NASDAQ"): Promise<OverseasAccountSnapshot> {
    const instrument = makeUsInstrument(exchange, symbol);
    const present = await this.getPresentBalance();
    const { positions: exchangePositions } = await this.getAllPositions();
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
      positions: exchangePositions.length ? exchangePositions : present.positions,
      buyingPower,
      cash: present.cash,
      fx: present.fx,
      estimatedKrwValue:
        present.estimatedKrwValue ??
        (usd && fxRate ? usd.cash * fxRate : present.estimatedKrwValue),
    };
  }

  /**
   * Same intent submits once. Deterministic broker reject → REJECTED.
   * Timeout / indeterminate → UNKNOWN (never blind-retried).
   * Intent is persisted before broker POST.
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
      kisPositions?: import("@/src/markets/overseas/types").OverseasPosition[];
      refreshBuyingPower?: boolean;
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
    const priorIntent = findIntent(box.current, input.intentId);
    if (priorIntent) {
      const blockedUnknown = priorIntent.status === "unknown" || priorIntent.status === "rejected";
      return {
        ok: !blockedUnknown,
        status:
          priorIntent.status === "rejected"
            ? "rejected"
            : priorIntent.status === "unknown"
              ? "unknown"
              : "pending",
        reason: priorIntent.reason ?? "same intent already submitted",
        orderNo: priorIntent.brokerOrderNo,
      };
    }

    let limitPrice: number;
    try {
      limitPrice = parseOverseasLimitPrice(input.price);
    } catch (err) {
      return {
        ok: false as const,
        status: "rejected" as const,
        reason: err instanceof Error ? err.message : "invalid limit price",
        orderNo: undefined,
      };
    }

    const firstQty = overseasFirstLifecycleQtyOk(input.qty);
    if (!firstQty.ok) {
      return { ok: false as const, status: "rejected" as const, reason: firstQty.blocked!, orderNo: undefined };
    }

    let orderableUsd = input.orderableUsd;
    if (
      input.side === "buy" &&
      (input.refreshBuyingPower === true || (input.refreshBuyingPower !== false && input.orderableUsd == null))
    ) {
      try {
        const power = await this.resolveFreshBuyingPower(input.instrument, limitPrice);
        orderableUsd = power.orderableCash;
      } catch {
        // keep provided orderableUsd; gate below still requires > 0
      }
    }

    if (input.side === "buy") {
      if (
        existingOpenBuy(box.current, identity) ||
        existingOpenBuy(box.current, input.instrument.symbol)
      ) {
        return {
          ok: false as const,
          status: "rejected" as const,
          reason: "ORDER TEST BLOCKED: Existing open BUY order detected",
          orderNo: undefined,
        };
      }
      if (usesPaperOrderPolicy()) {
        const paper = checkPaperOrderConstraints({
          qty: input.qty,
          ticker: identity,
          state: box.current,
        });
        if (!paper.ok) {
          return {
            ok: false as const,
            status: "rejected" as const,
            reason: paper.blocked ?? "ORDER TEST BLOCKED",
            orderNo: undefined,
          };
        }
      }
      const cashGate = overseasBuyCashGate(orderableUsd);
      if (!cashGate.ok) {
        return { ok: false as const, status: "rejected" as const, reason: cashGate.blocked, orderNo: undefined };
      }
      const risk = RiskManager.checkOverseasBuy({
        qty: input.qty,
        nativePrice: limitPrice,
        nativeCurrency: "USD",
        fxRate: input.fxRate,
        orderableNative: orderableUsd,
      });
      if (!risk.ok) {
        return { ok: false as const, status: "rejected" as const, reason: risk.reason, orderNo: undefined };
      }
      const instrument = overseasOneShareEligibility({
        symbol: input.instrument.symbol,
        nativePrice: limitPrice,
        usdOrderable: orderableUsd,
        fxRate: input.fxRate,
        qty: input.qty,
        env: process.env,
      });
      if (!instrument.eligible) {
        return { ok: false as const, status: "rejected" as const, reason: instrument.reason, orderNo: undefined };
      }
    } else {
      const sellGate = overseasSellQtyAllowed({
        qty: input.qty,
        identity,
        kisPositions: input.kisPositions ?? [],
        localPositions: box.current.positions.map((p) => ({ code: p.code, qty: p.qty })),
      });
      if (!sellGate.ok) {
        return { ok: false as const, status: "rejected" as const, reason: sellGate.blocked, orderNo: undefined };
      }
    }

    const upserted = upsertIntent(box.current, {
      intentId: input.intentId,
      signalId: input.signalId,
      ruleId: "overseas",
      ticker: identity,
      side: input.side,
      qty: input.qty,
      price: limitPrice,
      reason: "overseas-limit",
    });
    box.current = upserted.state;
    if (upserted.duplicate) {
      return {
        ok: false as const,
        status: "rejected" as const,
        reason: "same intent already submitted",
        orderNo: upserted.intent.brokerOrderNo,
      };
    }
    // Persist BEFORE broker POST (crash window: restart must see intent, POST count 0).
    await persistNow(box.current);

    try {
      const placed = await this.client.orderOverseasUs({
        instrument: input.instrument,
        side: input.side,
        qty: input.qty,
        price: limitPrice,
      });
      box.current = patchIntent(box.current, input.intentId, {
        status: "submitted",
        brokerOrderNo: placed.orderNo,
      });
      await persistNow(box.current);
      // ODNO received ≠ FILLED. Position changes only via execution/balance evidence.
      return { ok: true as const, status: "pending" as const, reason: undefined, orderNo: placed.orderNo };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "해외 주문 실패";
      if (err instanceof BrokerRejectError && !isIndeterminateError(err)) {
        box.current = patchIntent(box.current, input.intentId, { status: "rejected", reason });
        await persistNow(box.current);
        return { ok: false as const, status: "rejected" as const, reason, orderNo: undefined };
      }
      box.current = patchIntent(box.current, input.intentId, { status: "unknown", reason });
      await persistNow(box.current);
      return { ok: false as const, status: "unknown" as const, reason, orderNo: undefined };
    }
  }

  async cancelExact(
    order: KisOverseasCancel,
    opts: {
      openOrders?: OverseasOpenOrder[];
      localOrder?: import("@/lib/types").Order | null;
    } = {},
  ) {
    const locked = this.ordersLocked();
    if (locked) throw new Error(locked);
    if (opts.openOrders) {
      const allowed = overseasCancelAllowed({
        orderNo: order.orderNo,
        instrument: order.instrument,
        qty: order.qty,
        openOrders: opts.openOrders,
        localOrder: opts.localOrder,
      });
      if (!allowed.ok) throw new Error(allowed.blocked ?? "Cancel blocked");
    }
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
