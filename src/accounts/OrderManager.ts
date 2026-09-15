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
    const locked = executionLocked(this.box.current);
    if (locked) return { ok: false, reason: locked };
    const session = sessionBlockReason(this.box.current);
    if (session) return { ok: false, reason: session };
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
    if (session) return { ok: false, reason: session };
    if (!opts.liquidation) {
      const locked = executionLocked(this.box.current);
      if (locked) return { ok: false, reason: locked };
      const blocked = tradingBlocked(this.box.current);
      if (blocked) return { ok: false, reason: blocked };
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
    return this.toFill(patched.order);
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
    return this.toFill(withNo);
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
    return this.toFill(patched.order);
  }

  rejectRemote(orderId: string, reason: string): BrokerFill {
    const patched = patchOrder(this.box.current, orderId, {
      status: "rejected",
      reason,
    });
    if (patched.order) this.box.current = patched.state;
    return patched.order
      ? this.toFill(patched.order)
      : this.reject("", "buy", reason);
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

  buy(
    ruleId: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    const gate = this.canBuy(ruleId, qty, price, ticker);
    if (!gate.ok) {
      return this.reject(ticker, "buy", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: opts.source ?? "rule",
      sourceId: opts.sourceId,
      ruleId,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "buy",
      qty,
      price,
      ordDvsn: opts.ordDvsn,
    });
    this.box.current = applied.state;
    return this.toFill(applied.order);
  }

  sell(
    ruleId: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    const gate = this.canSell(ruleId, ticker, qty, opts);
    if (!gate.ok) {
      return this.reject(ticker, "sell", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: opts.source ?? "rule",
      sourceId: opts.sourceId,
      ruleId,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "sell",
      qty,
      price,
      ordDvsn: opts.ordDvsn,
    });
    this.box.current = applied.state;
    return this.toFill(applied.order);
  }
}
