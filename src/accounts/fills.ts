import { cashFromAllocations } from "@/src/accounts/defaults";
import type { AppState, Order, Position, Side } from "@/lib/types";

export function canFillLimit(side: Side, last: number, limitPrice: number): boolean {
  return side === "buy" ? last <= limitPrice : last >= limitPrice;
}

export const COMMISSION_RATE = 0.00015;
export const SELL_TAX_RATE = 0.0018;
export const MAX_ORDERS = 200;

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
    createdAt: draft.createdAt ?? new Date().toISOString(),
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
  };

  const reject = (reason: string) => {
    const rejected: Order = { ...order, status: "rejected", reason };
    return {
      state: {
        ...state,
        orders: [rejected, ...state.orders].slice(0, MAX_ORDERS),
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
        orders: [{ ...order, strategy: bucketKey }, ...state.orders].slice(0, MAX_ORDERS),
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
  const filled: Order = { ...order, strategy: creditTo };
  return {
    state: {
      ...state,
      cash: cashFromAllocations(allocations),
      allocations,
      positions: remaining,
      orders: [filled, ...state.orders].slice(0, MAX_ORDERS),
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
