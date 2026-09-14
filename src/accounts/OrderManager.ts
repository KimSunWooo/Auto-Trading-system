import { applyFill, feeBreakdown, findPosition } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill } from "@/src/brokers/IBroker";
import { findStock } from "@/lib/universe";
import type { OrderSource } from "@/lib/types";

export type OrderOpts = {
  source?: OrderSource;
  sourceId?: string;
  orderId?: string;
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
  ): { ok: true; net: number } | { ok: false; reason: string } {
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
    return { ok: true, net };
  }

  canSell(
    strategy: string,
    ticker: string,
    qty: number,
  ): { ok: true } | { ok: false; reason: string } {
    if (qty < 1) {
      return { ok: false, reason: "매도 수량이 없습니다." };
    }
    const existing = findPosition(this.box.current.positions, ticker, strategy);
    if (!existing || existing.qty < qty) {
      return { ok: false, reason: "매도 가능 수량이 부족합니다." };
    }
    return { ok: true };
  }

  private reject(
    ticker: string,
    side: "buy" | "sell",
    reason: string,
  ): BrokerFill {
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

  buy(
    strategy: string,
    ticker: string,
    qty: number,
    price: number,
    opts: OrderOpts = {},
  ): BrokerFill {
    const gate = this.canBuy(strategy, qty, price);
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
    const order = applied.order;
    return {
      ok: order.status === "filled",
      orderId: order.id,
      ticker,
      name: order.name,
      side: "buy",
      qty: order.qty,
      price: order.price,
      amount: order.amount,
      net: order.net,
      reason: order.reason,
    };
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
    const order = applied.order;
    return {
      ok: order.status === "filled",
      orderId: order.id,
      ticker,
      name: order.name,
      side: "sell",
      qty: order.qty,
      price: order.price,
      amount: order.amount,
      net: order.net,
      reason: order.reason,
    };
  }
}
