import {
  applyFill,
  confirmPendingFill,
  feeBreakdown,
  findPosition,
  patchOrder,
  recordPending,
} from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill } from "@/src/brokers/IBroker";
import { findStock } from "@/lib/universe";
import type { Order, OrderSource } from "@/lib/types";
import { checkHardLimits } from "@/src/risk/limits";
import { openCircuit, tradingBlocked } from "@/src/risk/circuit";
import { RiskManager } from "@/src/risk/RiskManager";
import { executionLocked } from "@/src/rules/disclaimer";
import { guardLog } from "@/src/rules/guard-log";
import { noteRuleOutcome, ruleThrottleReason } from "@/src/rules/throttle";
import { seoulDay } from "@/src/risk/limits";
import { findIntent, findOrderByIntent, patchIntent, upsertIntent } from "@/src/runtime/intents";
import { safetyOf, stopKey } from "@/src/runtime/safety";
import { isLiveLike } from "@/src/runtime/trading-mode";
import { holdsWorkerLock } from "@/src/runtime/worker-lock";
import { nowMs } from "@/src/clock";
import {
  bandLimitPrice,
  forbidsMarketOrder,
  planBandSlices,
  sessionBlockReason,
} from "@/src/accounts/execution-policy";

export type OrderOpts = {
  source?: OrderSource;
  sourceId?: string;
  orderId?: string;
  intentId?: string;
  ordDvsn?: "market" | "limit";
  /** Kill-switch flatten: skip circuit/unknown gates, still checks qty. */
  liquidation?: boolean;
};

/**
 * Gates every buy against the named cash bucket (user rule or 예수금).
 */
export class OrderManager {
  constructor(private readonly box: StateBox) {}

  static sessionBlockReason = sessionBlockReason;
  static forbidsMarketOrder = forbidsMarketOrder;
  static bandLimitPrice = bandLimitPrice;
  static planBandSlices = planBandSlices;

  canBuy(
    ruleId: string,
    qty: number,
    price: number,
    ticker = "",
  ): { ok: true; net: number } | { ok: false; reason: string } {
    if (this.box.current.settings.liquidating || this.box.current.circuit?.kind === "kill") {
      return { ok: false, reason: "긴급 정지로 신규 매수를 막았습니다." };
    }
    if (isLiveLike() && !holdsWorkerLock()) {
      return { ok: false, reason: "트레이딩 워커 락이 없어 주문하지 않습니다." };
    }
    const locked = executionLocked(this.box.current);
    if (locked) return { ok: false, reason: locked };
    const session = sessionBlockReason(this.box.current);
    if (session) {
      guardLog("정규장 아님", session);
      return { ok: false, reason: session };
    }
    const blocked = tradingBlocked(this.box.current);
    if (blocked) return { ok: false, reason: blocked };
    if (qty < 1) {
      return { ok: false, reason: "1주 미만이라 주문하지 않습니다." };
    }
    const { net } = feeBreakdown("buy", qty * price);
    const bucket = this.box.current.allocations.find((a) => a.ruleId === ruleId);
    if (!bucket) {
      return { ok: false, reason: `버킷 ${ruleId} 가 없습니다.` };
    }
    if (!bucket.enabled) {
      return { ok: false, reason: `${ruleId} 버킷이 중지되어 있습니다.` };
    }
    if (ticker) {
      const throttle = ruleThrottleReason(bucket, ticker);
      if (throttle) {
        guardLog("룰 쿨다운", throttle);
        return { ok: false, reason: throttle };
      }
      const safety = safetyOf(this.box.current);
      const key = stopKey(ruleId, ticker);
      if (safety.blockedBuys.includes(key)) {
        return { ok: false, reason: `${ticker} 손절 직후 같은 틱 재매수를 막았습니다.` };
      }
      if (safety.closedByStop[key] === seoulDay()) {
        return { ok: false, reason: `${ticker} 손절 당일 재진입을 막았습니다.` };
      }
    }
    if (bucket.balance < net) {
      return {
        ok: false,
        reason: `${ruleId} 잔액 ${bucket.balance.toLocaleString("ko-KR")}원으로는 ${net.toLocaleString("ko-KR")}원 주문을 낼 수 없습니다.`,
      };
    }
    if (ticker) {
      const hard = checkHardLimits(this.box.current, {
        side: "buy",
        ticker,
        qty,
        price,
      });
      if (hard) return { ok: false, reason: hard };
      const product = RiskManager.checkBuy(this.box.current, {
        side: "buy",
        ticker,
        qty,
        price,
      });
      if (product) return { ok: false, reason: product };
      const working = this.box.current.orders.find(
        (order) =>
          !order.parentOrderId &&
          (order.status === "pending" || order.status === "unknown") &&
          order.ruleId === ruleId &&
          order.code === ticker &&
          order.side === "buy",
      );
      if (working) {
        return { ok: false, reason: `${ticker} 미체결 주문이 있어 대기합니다.` };
      }
    }
    return { ok: true, net };
  }

  canSell(
    ruleId: string,
    ticker: string,
    qty: number,
    opts: Pick<OrderOpts, "liquidation"> = {},
  ): { ok: true } | { ok: false; reason: string } {
    const session = sessionBlockReason(this.box.current);
    if (session) {
      guardLog("정규장 아님", session);
      return { ok: false, reason: session };
    }
    if (!opts.liquidation) {
      if (isLiveLike() && !holdsWorkerLock()) {
        return { ok: false, reason: "트레이딩 워커 락이 없어 주문하지 않습니다." };
      }
      const locked = executionLocked(this.box.current);
      if (locked) return { ok: false, reason: locked };
      const blocked = tradingBlocked(this.box.current);
      if (blocked) return { ok: false, reason: blocked };
      const bucket = this.box.current.allocations.find((a) => a.ruleId === ruleId);
      const throttle = ruleThrottleReason(bucket, ticker);
      if (throttle) {
        guardLog("룰 쿨다운", throttle);
        return { ok: false, reason: throttle };
      }
    }
    if (qty < 1) {
      return { ok: false, reason: "매도 수량이 없습니다." };
    }
    const existing = findPosition(this.box.current.positions, ticker, ruleId);
    if (!existing || existing.qty < qty) {
      return { ok: false, reason: "매도 가능 수량이 부족합니다." };
    }
    if (!opts.liquidation) {
      const working = this.box.current.orders.find(
        (order) =>
          !order.parentOrderId &&
          (order.status === "pending" || order.status === "unknown") &&
          order.ruleId === ruleId &&
          order.code === ticker &&
          order.side === "sell",
      );
      if (working) {
        return { ok: false, reason: `${ticker} 미체결 매도가 있어 대기합니다.` };
      }
    }
    return { ok: true };
  }

  begin(
    ruleId: string,
    ticker: string,
    side: "buy" | "sell",
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): Order {
    if (opts.intentId) {
      const existing = findOrderByIntent(this.box.current, opts.intentId);
      if (existing) return existing;
      const prior = findIntent(this.box.current, opts.intentId);
      if (prior?.orderId) {
        const byId = this.box.current.orders.find((row) => row.id === prior.orderId);
        if (byId) return byId;
      }
      const committed = upsertIntent(this.box.current, {
        intentId: opts.intentId,
        signalId: opts.intentId,
        ruleId,
        ticker,
        side,
        qty,
        price,
        reason: "order-intent",
      });
      this.box.current = committed.state;
      if (committed.duplicate) {
        const prev = findOrderByIntent(this.box.current, opts.intentId);
        if (prev) return prev;
        return {
          id: committed.intent.orderId ?? committed.intent.intentId,
          createdAt: committed.intent.createdAt,
          source: opts.source ?? "rule",
          sourceId: opts.sourceId,
          ruleId,
          code: ticker,
          name: findStock(ticker)?.name ?? ticker,
          side,
          qty,
          price,
          amount: qty * price,
          commission: 0,
          tax: 0,
          net: 0,
          status: committed.intent.status === "rejected" ? "rejected" : "unknown",
          intentId: opts.intentId,
          reason: "동일 intent가 이미 있어 새 주문을 만들지 않습니다.",
        };
      }
    }
    const stock = findStock(ticker);
    const started = recordPending(this.box.current, {
      id: opts.orderId,
      intentId: opts.intentId,
      source: opts.source ?? "rule",
      sourceId: opts.sourceId,
      ruleId,
      code: ticker,
      name: stock?.name ?? ticker,
      side,
      qty,
      price,
      ordDvsn: opts.ordDvsn,
    });
    this.box.current = started.state;
    this.touchOrderClock();
    if (opts.intentId) {
      this.box.current = patchIntent(this.box.current, opts.intentId, {
        status: "pending",
        orderId: started.order.id,
      });
    }
    return started.order;
  }

  ackWorking(
    orderId: string,
    brokerOrderNo: string,
    reason: string,
    extra?: { krxOrgNo?: string; ordDvsn?: "market" | "limit" },
  ): BrokerFill {
    const patched = patchOrder(this.box.current, orderId, {
      status: "pending",
      brokerOrderNo,
      krxOrgNo: extra?.krxOrgNo,
      ordDvsn: extra?.ordDvsn,
      reason,
    });
    if (!patched.order) {
      return this.reject("", "buy", reason);
    }
    this.box.current = patched.state;
    const fill = this.toFill(patched.order);
    this.observe(patched.order.ruleId, patched.order.code, fill);
    return fill;
  }

  confirm(orderId: string, brokerOrderNo?: string): BrokerFill {
    const applied = confirmPendingFill(this.box.current, orderId, { brokerOrderNo });
    const withNo = applied.order.status === "filled" && brokerOrderNo
      ? {
          ...applied.order,
          brokerOrderNo,
        }
      : applied.order;
    this.box.current = {
      ...applied.state,
      orders: applied.state.orders.map((row) => (row.id === withNo.id ? withNo : row)),
    };
    const fill = this.toFill(withNo);
    this.observe(withNo.ruleId, withNo.code, fill);
    return fill;
  }

  unknown(orderId: string, reason: string): BrokerFill {
    const patched = patchOrder(this.box.current, orderId, {
      status: "unknown",
      reason,
    });
    if (!patched.order) {
      return this.reject("", "buy", reason);
    }
    this.box.current = openCircuit(
      patched.state,
      `주문 결과를 확인하지 못했습니다. ${reason}`,
      patched.order,
    );
    const fill = this.toFill(patched.order);
    this.observe(patched.order.ruleId, patched.order.code, fill);
    return fill;
  }

  rejectRemote(orderId: string, reason: string): BrokerFill {
    const patched = patchOrder(this.box.current, orderId, {
      status: "rejected",
      reason,
    });
    if (patched.order) this.box.current = patched.state;
    const fill = patched.order
      ? this.toFill(patched.order)
      : this.reject("", "buy", reason);
    if (patched.order) this.observe(patched.order.ruleId, patched.order.code, fill);
    return fill;
  }

  gateReject(ruleId: string, ticker: string, side: "buy" | "sell", reason: string): BrokerFill {
    const fill = this.reject(ticker, side, reason);
    this.observe(ruleId, ticker, fill);
    return fill;
  }

  observe(ruleId: string | undefined, ticker: string, fill: BrokerFill) {
    if (!ruleId || !ticker) return;
    this.box.current = noteRuleOutcome(this.box.current, {
      ruleId,
      ticker,
      status: fill.status,
      reason: fill.reason,
      ok: fill.ok,
    });
  }

  private reject(
    ticker: string,
    side: "buy" | "sell",
    reason: string,
  ): BrokerFill {
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

  toFill(order: Order): BrokerFill {
    return {
      ok: order.status === "filled",
      status: order.status,
      orderId: order.id,
      ticker: order.code,
      name: order.name,
      side: order.side,
      qty: order.qty,
      price: order.price,
      amount: order.amount,
      net: order.net,
      reason: order.reason,
    };
  }

  private asLimit(
    side: "buy" | "sell",
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts,
  ): { qty: number; price: number; opts: OrderOpts } | { reason: string } {
    if (opts.ordDvsn === "limit") {
      return { qty, price, opts };
    }
    const quote = this.box.current.quotes[ticker];
    const last = quote?.price && quote.price > 0 ? quote.price : price;
    const band = bandLimitPrice(side, last, quote?.prevClose ?? last);
    if (!(band > 0)) {
      return { reason: "현재가가 없어 지정가 밴드를 계산하지 못했습니다." };
    }
    return {
      qty,
      price: last,
      opts: { ...opts, ordDvsn: "limit" },
    };
  }

  buy(
    ruleId: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    if (opts.intentId) {
      const existing = findOrderByIntent(this.box.current, opts.intentId);
      if (existing) return this.toFill(existing);
    }
    const converted = this.asLimit("buy", ticker, qty, price, opts);
    if ("reason" in converted) {
      return this.gateReject(ruleId, ticker, "buy", converted.reason);
    }
    const gate = this.canBuy(ruleId, converted.qty, converted.price, ticker);
    if (!gate.ok) {
      return this.gateReject(ruleId, ticker, "buy", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: converted.opts.source ?? "rule",
      sourceId: converted.opts.sourceId,
      ruleId,
      intentId: converted.opts.intentId,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "buy",
      qty: converted.qty,
      price: converted.price,
      ordDvsn: converted.opts.ordDvsn,
    });
    this.box.current = applied.state;
    this.touchOrderClock();
    this.rememberIntent(opts.intentId, ruleId, ticker, "buy", converted.qty, converted.price, applied.order);
    const fill = this.toFill(applied.order);
    this.observe(ruleId, ticker, fill);
    return fill;
  }

  sell(
    ruleId: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    if (opts.intentId) {
      const existing = findOrderByIntent(this.box.current, opts.intentId);
      if (existing) return this.toFill(existing);
    }
    const converted = this.asLimit("sell", ticker, qty, price, opts);
    if ("reason" in converted) {
      return this.gateReject(ruleId, ticker, "sell", converted.reason);
    }
    const gate = this.canSell(ruleId, ticker, converted.qty, opts);
    if (!gate.ok) {
      return this.gateReject(ruleId, ticker, "sell", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: converted.opts.source ?? "rule",
      sourceId: converted.opts.sourceId,
      ruleId,
      intentId: converted.opts.intentId,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "sell",
      qty: converted.qty,
      price: converted.price,
      ordDvsn: converted.opts.ordDvsn,
    });
    this.box.current = applied.state;
    this.touchOrderClock();
    this.rememberIntent(opts.intentId, ruleId, ticker, "sell", converted.qty, converted.price, applied.order);
    const fill = this.toFill(applied.order);
    if (!opts.liquidation) this.observe(ruleId, ticker, fill);
    return fill;
  }

  private touchOrderClock() {
    this.box.current = {
      ...this.box.current,
      safety: {
        ...safetyOf(this.box.current),
        lastOrderAt: nowMs(),
      },
    };
  }

  private rememberIntent(
    intentId: string | undefined,
    ruleId: string,
    ticker: string,
    side: "buy" | "sell",
    qty: number,
    price: number,
    order: Order,
  ) {
    if (!intentId) return;
    const committed = upsertIntent(this.box.current, {
      intentId,
      signalId: intentId,
      ruleId,
      ticker,
      side,
      qty,
      price,
      reason: "order-intent",
    });
    this.box.current = patchIntent(committed.state, intentId, {
      status: order.status === "filled" ? "filled" : order.status === "rejected" ? "rejected" : "submitted",
      orderId: order.id,
      brokerOrderNo: order.brokerOrderNo,
    });
  }
}
