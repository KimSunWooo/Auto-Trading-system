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

export type OrderOpts = {
  source?: OrderSource;
  sourceId?: string;
  orderId?: string;
  intentId?: string;
};

/**
 * Gates every buy against the strategy sub-account.
 * Strategies never spend another bucket's cash.
 */
export class OrderManager {
  constructor(private readonly box: StateBox) {}

  canBuy(
    strategy: string,
    qty: number,
    price: number,
    ticker = "",
  ): { ok: true; net: number } | { ok: false; reason: string } {
    const blocked = tradingBlocked(this.box.current);
    if (blocked) return { ok: false, reason: blocked };
    if (qty < 1) {
      return { ok: false, reason: "1주 미만이라 주문하지 않습니다." };
    }
    const { net } = feeBreakdown("buy", qty * price);
    const bucket = this.box.current.allocations.find((a) => a.strategy === strategy);
    if (!bucket) {
      return { ok: false, reason: `버킷 ${strategy} 가 없습니다.` };
    }
    if (!bucket.enabled) {
      return { ok: false, reason: `${strategy} 버킷이 중지되어 있습니다.` };
    }
    if (bucket.balance < net) {
      return {
        ok: false,
        reason: `${strategy} 잔액 ${bucket.balance.toLocaleString("ko-KR")}원으로는 ${net.toLocaleString("ko-KR")}원 주문을 낼 수 없습니다.`,
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
    }
    return { ok: true, net };
  }

  canSell(
    strategy: string,
    ticker: string,
    qty: number,
  ): { ok: true } | { ok: false; reason: string } {
    const blocked = tradingBlocked(this.box.current);
    if (blocked) return { ok: false, reason: blocked };
    if (qty < 1) {
      return { ok: false, reason: "매도 수량이 없습니다." };
    }
    const existing = findPosition(this.box.current.positions, ticker, strategy);
    if (!existing || existing.qty < qty) {
      return { ok: false, reason: "매도 가능 수량이 부족합니다." };
    }
    return { ok: true };
  }

  begin(
    strategy: string,
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
      source: opts.source ?? "strategy",
      sourceId: opts.sourceId,
      strategy,
      code: ticker,
      name: stock?.name ?? ticker,
      side,
      qty,
      price,
    });
    this.box.current = started.state;
    return started.order;
  }

  ackWorking(orderId: string, brokerOrderNo: string, reason: string): BrokerFill {
    const patched = patchOrder(this.box.current, orderId, {
      status: "pending",
      brokerOrderNo,
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
    strategy: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    const gate = this.canBuy(strategy, qty, price, ticker);
    if (!gate.ok) {
      return this.reject(ticker, "buy", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: opts.source ?? "strategy",
      sourceId: opts.sourceId,
      strategy,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "buy",
      qty,
      price,
    });
    this.box.current = applied.state;
    return this.toFill(applied.order);
  }

  sell(
    strategy: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    const gate = this.canSell(strategy, ticker, qty);
    if (!gate.ok) {
      return this.reject(ticker, "sell", gate.reason);
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      id: opts.orderId,
      source: opts.source ?? "strategy",
      sourceId: opts.sourceId,
      strategy,
      code: ticker,
      name: stock?.name ?? ticker,
      side: "sell",
      qty,
      price,
    });
    this.box.current = applied.state;
    return this.toFill(applied.order);
  }
}
