import { clampDailyLimit, roundToTick, tickSize } from "./tick-size";
import type {
  AppState,
  AutoCondition,
  DcaPlan,
  Order,
  Position,
  Quote,
  Side,
} from "./types";
import { UNIVERSE } from "./universe";
import { getMarketClock } from "./market-hours";

const COMMISSION_RATE = 0.00015;
const SELL_TAX_RATE = 0.0018;
const HISTORY_LEN = 40;
const MAX_ORDERS = 200;

export function createInitialQuotes(): Record<string, Quote> {
  const quotes: Record<string, Quote> = {};
  for (const seed of UNIVERSE) {
    const price = roundToTick(seed.prevClose);
    const tick = tickSize(price);
    quotes[seed.code] = {
      code: seed.code,
      name: seed.name,
      market: seed.market,
      price,
      prevClose: seed.prevClose,
      open: price,
      high: price,
      low: price,
      volume: 120_000 + Math.floor(Math.random() * 80_000),
      bid: roundToTick(price - tick),
      ask: roundToTick(price + tick),
      history: Array.from({ length: HISTORY_LEN }, () => price),
    };
  }
  return quotes;
}

export function createInitialState(): AppState {
  const startingCash = 10_000_000;
  return {
    updatedAt: new Date().toISOString(),
    tickCount: 0,
    settings: {
      ignoreMarketHours: true,
      startingCash,
    },
    cash: startingCash,
    positions: [],
    quotes: createInitialQuotes(),
    conditions: [],
    dcaPlans: [],
    orders: [],
  };
}

export function advanceQuotes(
  quotes: Record<string, Quote>,
  rng: () => number = Math.random,
): Record<string, Quote> {
  const next: Record<string, Quote> = {};
  for (const [code, q] of Object.entries(quotes)) {
    const vol = 0.0012 + rng() * 0.004;
    const shock = (rng() - 0.5) * 2 * vol;
    const raw = q.price * (1 + shock);
    const price = clampDailyLimit(raw, q.prevClose);
    const tick = tickSize(price);
    const bid = roundToTick(Math.max(tick, price - tick));
    const ask = roundToTick(price + tick);
    const history = [...q.history, price].slice(-HISTORY_LEN);
    next[code] = {
      ...q,
      price,
      high: Math.max(q.high, price),
      low: Math.min(q.low, price),
      volume: q.volume + Math.floor(400 + rng() * 2200),
      bid,
      ask,
      history,
    };
  }
  return next;
}

export function watchPrice(quote: Quote, cond: AutoCondition): number {
  if (cond.watchBasis === "bid") return quote.bid;
  if (cond.watchBasis === "ask") return quote.ask;
  return quote.price;
}

export function conditionMatches(cond: AutoCondition, quote: Quote): boolean {
  const price = watchPrice(quote, cond);
  const priceOk =
    cond.operator === "gte" ? price >= cond.triggerPrice : price <= cond.triggerPrice;
  if (!priceOk) return false;
  if (!cond.volumeEnabled) return true;
  return cond.volumeOp === "gte"
    ? quote.volume >= cond.volume
    : quote.volume <= cond.volume;
}

export function canFillLimit(side: Side, last: number, limitPrice: number): boolean {
  return side === "buy" ? last <= limitPrice : last >= limitPrice;
}

function roundWon(n: number): number {
  return Math.round(n);
}

export function feeBreakdown(side: Side, amount: number) {
  const commission = roundWon(amount * COMMISSION_RATE);
  const tax = side === "sell" ? roundWon(amount * SELL_TAX_RATE) : 0;
  const net = side === "buy" ? amount + commission : amount - commission - tax;
  return { commission, tax, net };
}

export function findPosition(positions: Position[], code: string) {
  return positions.find((p) => p.code === code);
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

  const positions = state.positions.map((p) => ({ ...p }));
  let cash = state.cash;

  if (draft.side === "buy") {
    if (cash < fees.net) {
      const rejected = {
        ...order,
        status: "rejected" as const,
        reason: "예수금이 부족합니다.",
      };
      return {
        state: {
          ...state,
          orders: [rejected, ...state.orders].slice(0, MAX_ORDERS),
        },
        order: rejected,
      };
    }
    cash -= fees.net;
    const existing = positions.find((p) => p.code === draft.code);
    if (existing) {
      const totalQty = existing.qty + draft.qty;
      existing.avgPrice = (existing.avgPrice * existing.qty + draft.price * draft.qty) / totalQty;
      existing.qty = totalQty;
    } else {
      positions.push({
        code: draft.code,
        name: draft.name,
        qty: draft.qty,
        avgPrice: draft.price,
      });
    }
  } else {
    const existing = positions.find((p) => p.code === draft.code);
    if (!existing || existing.qty < draft.qty) {
      const rejected = {
        ...order,
        status: "rejected" as const,
        reason: "매도 가능 수량이 부족합니다.",
      };
      return {
        state: {
          ...state,
          orders: [rejected, ...state.orders].slice(0, MAX_ORDERS),
        },
        order: rejected,
      };
    }
    existing.qty -= draft.qty;
    cash += fees.net;
    const remaining = positions.filter((p) => p.qty > 0);
    return {
      state: {
        ...state,
        cash,
        positions: remaining,
        orders: [order, ...state.orders].slice(0, MAX_ORDERS),
      },
      order,
    };
  }

  return {
    state: {
      ...state,
      cash,
      positions,
      orders: [order, ...state.orders].slice(0, MAX_ORDERS),
    },
    order,
  };
}

function equityOf(state: AppState): number {
  const holdings = state.positions.reduce((sum, p) => {
    const quote = state.quotes[p.code];
    return sum + p.qty * (quote?.price ?? p.avgPrice);
  }, 0);
  return state.cash + holdings;
}

export function evaluateConditions(state: AppState, nowIso: string): AppState {
  let next = state;
  const now = new Date(nowIso).getTime();

  next = {
    ...next,
    conditions: next.conditions.map((cond) => {
      if (cond.status === "watching" && now > new Date(cond.expiresAt).getTime()) {
        return {
          ...cond,
          watching: false,
          status: "expired" as const,
          message: "조건기간이 만료되었습니다.",
        };
      }
      return cond;
    }),
  };

  for (const cond of next.conditions) {
    if (!cond.watching || cond.status !== "watching") continue;
    const quote = next.quotes[cond.code];
    if (!quote) continue;
    if (!conditionMatches(cond, quote)) continue;

    const fillPrice =
      cond.orderPriceType === "limit" && cond.limitPrice
        ? cond.limitPrice
        : quote.price;

    if (cond.orderPriceType === "limit" && cond.limitPrice) {
      if (!canFillLimit(cond.side, quote.price, cond.limitPrice)) continue;
    }

    const applied = applyFill(next, {
      source: "condition",
      sourceId: cond.id,
      code: cond.code,
      name: cond.name,
      side: cond.side,
      qty: cond.qty,
      price: fillPrice,
    });

    const updatedCond: AutoCondition =
      applied.order.status === "filled"
        ? {
            ...cond,
            watching: false,
            status: "filled",
            filledAt: applied.order.createdAt,
            filledOrderId: applied.order.id,
            message: `${cond.side === "buy" ? "매수" : "매도"} ${cond.qty}주 체결`,
          }
        : {
            ...cond,
            watching: false,
            status: "rejected",
            message: applied.order.reason,
          };

    next = {
      ...applied.state,
      conditions: applied.state.conditions.map((c) => (c.id === cond.id ? updatedCond : c)),
    };
  }

  return next;
}

export function evaluateDca(state: AppState, nowIso: string): AppState {
  let next = state;
  const now = new Date(nowIso).getTime();

  for (const plan of next.dcaPlans) {
    if (!plan.enabled) continue;
    if (new Date(plan.nextRunAt).getTime() > now) continue;
    const quote = next.quotes[plan.code];
    if (!quote) continue;

    const qty = Math.floor(plan.amountKrw / quote.price);
    const scheduled: DcaPlan = {
      ...plan,
      nextRunAt: new Date(now + plan.intervalSec * 1000).toISOString(),
      runCount: plan.runCount + 1,
    };

    if (qty < 1) {
      next = {
        ...next,
        dcaPlans: next.dcaPlans.map((p) =>
          p.id === plan.id
            ? { ...scheduled, lastMessage: "1주 미만이라 이번 회차는 건너뜁니다." }
            : p,
        ),
      };
      continue;
    }

    const applied = applyFill(next, {
      source: "dca",
      sourceId: plan.id,
      code: plan.code,
      name: plan.name,
      side: "buy",
      qty,
      price: quote.price,
    });

    const updatedPlan: DcaPlan = {
      ...scheduled,
      lastMessage:
        applied.order.status === "filled"
          ? `${qty}주 적립 매수`
          : applied.order.reason,
    };

    next = {
      ...applied.state,
      dcaPlans: applied.state.dcaPlans.map((p) => (p.id === plan.id ? updatedPlan : p)),
    };
  }

  return next;
}

export function tickState(state: AppState, now = new Date()): AppState {
  const clock = getMarketClock(now);
  const quotes = advanceQuotes(state.quotes);
  let next: AppState = {
    ...state,
    quotes,
    tickCount: state.tickCount + 1,
    updatedAt: clock.iso,
  };

  const tradingAllowed = state.settings.ignoreMarketHours || clock.open;
  if (tradingAllowed) {
    next = evaluateConditions(next, clock.iso);
    next = evaluateDca(next, clock.iso);
  }

  return next;
}

export function portfolioValue(state: AppState): number {
  return equityOf(state);
}
