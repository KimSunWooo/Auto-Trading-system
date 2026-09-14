import { applyFill, feeBreakdown } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { BrokerFill } from "@/src/brokers/IBroker";
import { findStock } from "@/lib/universe";
import type { OrderSource } from "@/lib/types";

/**
 * Gates every buy against the strategy sub-account.
 * Strategies never spend another bucket's cash.
 */
export class OrderManager {
  constructor(private readonly box: StateBox) {}

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
    source: OrderSource = "strategy",
  ): BrokerFill {
    if (qty < 1) {
      return this.reject(ticker, "buy", "1주 미만이라 주문하지 않습니다.");
    }
    const stock = findStock(ticker);
    const amount = qty * price;
    const { net } = feeBreakdown("buy", amount);
    const bucket = this.box.current.allocations.find((a) => a.strategy === strategy);
    if (!bucket) {
      return this.reject(ticker, "buy", `버킷 ${strategy} 가 없습니다.`);
    }
    if (!bucket.enabled) {
      return this.reject(ticker, "buy", `${strategy} 버킷이 중지되어 있습니다.`);
    }
    if (bucket.balance < net) {
      return this.reject(
        ticker,
        "buy",
        `${strategy} 잔액 ${bucket.balance.toLocaleString("ko-KR")}원으로는 ${net.toLocaleString("ko-KR")}원 주문을 낼 수 없습니다.`,
      );
    }

    const applied = applyFill(this.box.current, {
      source,
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
    source: OrderSource = "strategy",
  ): BrokerFill {
    if (qty < 1) {
      return this.reject(ticker, "sell", "매도 수량이 없습니다.");
    }
    const stock = findStock(ticker);
    const applied = applyFill(this.box.current, {
      source,
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
