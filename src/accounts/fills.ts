import { nowIso } from "@/src/clock";
import { cashFromAllocations } from "@/src/accounts/defaults";
import type { AppState, Order, OrderSource, Position, Side } from "@/lib/types";

export function canFillLimit(side: Side, last: number, limitPrice: number): boolean {
  return side === "buy" ? last <= limitPrice : last >= limitPrice;
}

export const COMMISSION_RATE = 0.00015;
export const SELL_TAX_RATE = 0.0018;
export const MAX_ORDERS = 200;

/** Local estimate only. Live safety is inquire-balance vs buckets, not this rate. */
export function feeBreakdown(side: Side, amount: number) {
  const commission = Math.round(amount * COMMISSION_RATE);
  const tax = side === "sell" ? Math.round(amount * SELL_TAX_RATE) : 0;
  const net = side === "buy" ? amount + commission : amount - commission - tax;
  return { commission, tax, net };
}

export function pickBucket(state: AppState, need: number, strategy?: string): string | null {
  if (strategy) {
    const named = state.allocations.find((a) => a.strategy === strategy);
    if (named && named.balance >= need) return named.strategy;
    return null;
  }
  return state.allocations.find((a) => a.balance >= need)?.strategy ?? null;
}

export function applyFill(
  state: AppState,
  draft: Omit<
    Order,
    "id" | "createdAt" | "commission" | "tax" | "net" | "status" | "reason" | "amount"
  > & {
    id?: string;
    createdAt?: string;
  },
): { state: AppState; order: Order } {
  const amount = draft.qty * draft.price;
  const fees = feeBreakdown(draft.side, amount);
  const order: Order = {
    id: draft.id ?? crypto.randomUUID(),
    createdAt: draft.createdAt ?? nowIso(),
    source: draft.source,
    sourceId: draft.sourceId,
    strategy: draft.strategy,
    code: draft.code,
    name: draft.name,
    side: draft.side,
    qty: draft.qty,
    price: draft.price,
    amount,
    commission: fees.commission,
    tax: fees.tax,
    net: fees.net,
    status: "filled",
    parentOrderId: draft.parentOrderId,
    brokerOrderNo: draft.brokerOrderNo,
    krxOrgNo: draft.krxOrgNo,
    ordDvsn: draft.ordDvsn,
    orderedQty: draft.orderedQty,
    filledQty: draft.filledQty ?? draft.qty,
  };

  const reject = (reason: string) => {
    const rejected: Order = { ...order, status: "rejected", reason };
    return {
      state: {
        ...state,
        orders: trimOrderLog([rejected, ...state.orders]),
      },
      order: rejected,
    };
  };

  const positions = state.positions.map((p) => ({ ...p }));
  let allocations = state.allocations.map((a) => ({ ...a }));

  if (draft.side === "buy") {
    const bucketKey = pickBucket(state, fees.net, draft.strategy);
    if (!bucketKey) {
      return reject(
        draft.strategy
          ? `${draft.strategy} 버킷 잔액이 부족합니다.`
          : "전략 버킷 잔액이 부족합니다.",
      );
    }
    allocations = allocations.map((a) =>
      a.strategy === bucketKey ? { ...a, balance: a.balance - fees.net } : a,
    );
    const existing = positions.find(
      (p) => p.code === draft.code && p.strategy === bucketKey,
    );
    if (existing) {
      const totalQty = existing.qty + draft.qty;
      existing.avgPrice =
        (existing.avgPrice * existing.qty + draft.price * draft.qty) / totalQty;
      existing.qty = totalQty;
    } else {
      positions.push({
        code: draft.code,
        name: draft.name,
        qty: draft.qty,
        avgPrice: draft.price,
        strategy: bucketKey,
      });
    }
    order.strategy = bucketKey;
    const cash = cashFromAllocations(allocations);
    return {
      state: {
        ...state,
        cash,
        allocations,
        positions,
        orders: trimOrderLog([{ ...order, strategy: bucketKey }, ...state.orders]),
      },
      order: { ...order, strategy: bucketKey },
    };
  }

  const strategyKey = draft.strategy;
  const existing = positions.find(
    (p) => p.code === draft.code && (!strategyKey || p.strategy === strategyKey),
  );
  if (!existing || existing.qty < draft.qty) {
    return reject("매도 가능 수량이 부족합니다.");
  }
  existing.qty -= draft.qty;
  const creditTo = existing.strategy;
  allocations = allocations.map((a) =>
    a.strategy === creditTo ? { ...a, balance: a.balance + fees.net } : a,
  );
  const remaining = positions.filter((p) => p.qty > 0);
  const realizedPnl = Math.round(
    (draft.price - existing.avgPrice) * draft.qty - fees.commission - fees.tax,
  );
  const filled: Order = { ...order, strategy: creditTo, realizedPnl };
  return {
    state: {
      ...state,
      cash: cashFromAllocations(allocations),
      allocations,
      positions: remaining,
      orders: trimOrderLog([filled, ...state.orders]),
    },
    order: filled,
  };
}

export function findPosition(
  positions: Position[],
  code: string,
  strategy?: string,
) {
  return positions.find(
    (p) => p.code === code && (!strategy || p.strategy === strategy),
  );
}

export function trimOrderLog(orders: Order[]): Order[] {
  const sticky = orders.filter((o) => o.status === "pending" || o.status === "unknown");
  const rest = orders.filter((o) => o.status !== "pending" && o.status !== "unknown");
  return [...sticky, ...rest].slice(0, Math.max(MAX_ORDERS, sticky.length));
}

export function recordPending(
  state: AppState,
  draft: {
    id?: string;
    source: OrderSource;
    sourceId?: string;
    strategy?: string;
    code: string;
    name: string;
    side: Side;
    qty: number;
    price: number;
    intentId?: string;
  },
): { state: AppState; order: Order } {
  const amount = draft.qty * draft.price;
  const fees = feeBreakdown(draft.side, amount);
  const order: Order = {
    id: draft.id ?? crypto.randomUUID(),
    createdAt: nowIso(),
    source: draft.source,
    sourceId: draft.sourceId,
    strategy: draft.strategy,
    code: draft.code,
    name: draft.name,
    side: draft.side,
    qty: draft.qty,
    price: draft.price,
    amount,
    commission: fees.commission,
    tax: fees.tax,
    net: fees.net,
    status: "pending",
    intentId: draft.intentId ?? crypto.randomUUID(),
    reason: "증권사 응답 대기",
    orderedQty: draft.qty,
    filledQty: 0,
  };
  return {
    state: {
      ...state,
      orders: trimOrderLog([order, ...state.orders.filter((row) => row.id !== order.id)]),
    },
    order,
  };
}

export function patchOrder(
  state: AppState,
  orderId: string,
  patch: Partial<Order>,
): { state: AppState; order: Order | undefined } {
  const current = state.orders.find((row) => row.id === orderId);
  if (!current) return { state, order: undefined };
  const order = { ...current, ...patch };
  return {
    state: {
      ...state,
      orders: trimOrderLog(state.orders.map((row) => (row.id === orderId ? order : row))),
    },
    order,
  };
}

export function confirmPendingFill(
  state: AppState,
  orderId: string,
  extra?: { brokerOrderNo?: string; price?: number; qty?: number },
): { state: AppState; order: Order } {
  const pending = state.orders.find((row) => row.id === orderId);
  if (!pending) {
    const rejected: Order = {
      id: orderId,
      createdAt: nowIso(),
      source: "strategy",
      code: "",
      name: "",
      side: "buy",
      qty: 0,
      price: 0,
      amount: 0,
      commission: 0,
      tax: 0,
      net: 0,
      status: "rejected",
      reason: "대기 주문을 찾지 못했습니다.",
    };
    return { state, order: rejected };
  }
  const without = {
    ...state,
    orders: state.orders.filter((row) => row.id !== orderId),
  };
  return applyFill(without, {
    id: pending.id,
    createdAt: pending.createdAt,
    source: pending.source,
    sourceId: pending.sourceId,
    strategy: pending.strategy,
    code: pending.code,
    name: pending.name,
    side: pending.side,
    qty: extra?.qty ?? pending.qty,
    price: extra?.price ?? pending.price,
    brokerOrderNo: extra?.brokerOrderNo ?? pending.brokerOrderNo,
    krxOrgNo: pending.krxOrgNo,
    ordDvsn: pending.ordDvsn,
    orderedQty: pending.orderedQty ?? pending.qty,
    filledQty: extra?.qty ?? pending.qty,
  });
}

/**
 * Book only the newly reported fill qty as a child order.
 * The parent stays open until remaining qty is filled or cancelled.
 */
export function bookReportedFill(
  state: AppState,
  parentId: string,
  input: { filledQty: number; avgPrice?: number; brokerOrderNo?: string },
): { state: AppState; parent: Order; child?: Order } {
  const parent = state.orders.find((row) => row.id === parentId);
  if (!parent) {
    return {
      state,
      parent: {
        id: parentId,
        createdAt: nowIso(),
        source: "strategy",
        code: "",
        name: "",
        side: "buy",
        qty: 0,
        price: 0,
        amount: 0,
        commission: 0,
        tax: 0,
        net: 0,
        status: "rejected",
        reason: "대기 주문을 찾지 못했습니다.",
      },
    };
  }

  const ordered = parent.orderedQty ?? parent.qty;
  const already = parent.filledQty ?? 0;
  const reported = Math.max(0, Math.min(Math.floor(input.filledQty), ordered));
  const delta = reported - already;
  if (delta < 1) {
    if (reported >= ordered && parent.status !== "filled") {
      const patched = patchOrder(state, parent.id, {
        filledQty: reported,
        status: "filled",
        reason: "전량 체결",
        brokerOrderNo: input.brokerOrderNo ?? parent.brokerOrderNo,
      });
      return { state: patched.state, parent: patched.order ?? parent };
    }
    return { state, parent };
  }

  const applied = applyFill(state, {
    source: parent.source,
    sourceId: parent.sourceId,
    strategy: parent.strategy,
    code: parent.code,
    name: parent.name,
    side: parent.side,
    qty: delta,
    price: input.avgPrice && input.avgPrice > 0 ? input.avgPrice : parent.price,
    parentOrderId: parent.id,
    brokerOrderNo: input.brokerOrderNo ?? parent.brokerOrderNo,
    krxOrgNo: parent.krxOrgNo,
    ordDvsn: parent.ordDvsn,
  });

  if (applied.order.status !== "filled") {
    const patched = patchOrder(applied.state, parent.id, {
      status: "unknown",
      reason: applied.order.reason ?? "증권사 체결을 로컬 장부에 반영하지 못했습니다.",
      brokerOrderNo: input.brokerOrderNo ?? parent.brokerOrderNo,
    });
    return { state: patched.state, parent: patched.order ?? parent, child: applied.order };
  }

  const newFilled = already + delta;
  const done = newFilled >= ordered;
  const patched = patchOrder(applied.state, parent.id, {
    filledQty: newFilled,
    status: done ? "filled" : parent.status,
    reason: done ? "전량 체결" : `부분체결 ${newFilled}/${ordered}주`,
    brokerOrderNo: input.brokerOrderNo ?? parent.brokerOrderNo,
  });
  return { state: patched.state, parent: patched.order ?? parent, child: applied.order };
}
