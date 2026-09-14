import { clampDailyLimit, roundToTick, tickSize } from "./tick-size";
import type { AppState, AutoCondition, DcaPlan, Quote } from "./types";
import { UNIVERSE } from "./universe";
import { getMarketClock } from "./market-hours";
import { applyFill, canFillLimit } from "@/src/accounts/fills";
import { cashFromAllocations, DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { QuantEngine } from "@/src/engine/QuantEngine";

const HISTORY_LEN = 40;

export { applyFill, canFillLimit, feeBreakdown, findPosition } from "@/src/accounts/fills";

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
  const allocations = DEFAULT_ALLOCATIONS.map((row) => ({ ...row }));
  return {
    updatedAt: new Date().toISOString(),
    tickCount: 0,
    settings: {
      ignoreMarketHours: true,
      startingCash: TOTAL_DEPOSIT,
      broker: "mock",
    },
    totalDeposit: TOTAL_DEPOSIT,
    allocations,
    cash: cashFromAllocations(allocations),
    positions: [],
    quotes: createInitialQuotes(),
    conditions: [],
    dcaPlans: [],
    orders: [],
  };
}

export function ensureUniverseQuotes(state: AppState): AppState {
  const quotes = { ...state.quotes };
  const seeded = createInitialQuotes();
  for (const [code, quote] of Object.entries(seeded)) {
    if (!quotes[code]) quotes[code] = quote;
  }
  return { ...state, quotes };
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
      strategy: cond.strategy ?? "Level1_Stable",
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
      strategy: plan.strategy ?? "Level1_Stable",
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

export async function tickState(state: AppState, now = new Date()): Promise<AppState> {
  const clock = getMarketClock(now);
  const withUniverse = ensureUniverseQuotes(state);
  const quotes = advanceQuotes(withUniverse.quotes);
  let next: AppState = {
    ...withUniverse,
    quotes,
    tickCount: state.tickCount + 1,
    updatedAt: clock.iso,
  };

  const tradingAllowed = state.settings.ignoreMarketHours || clock.open;
  if (tradingAllowed) {
    next = evaluateConditions(next, clock.iso);
    next = evaluateDca(next, clock.iso);
    next = await QuantEngine.run(next);
  }

  return next;
}

export function portfolioValue(state: AppState): number {
  const holdings = state.positions.reduce((sum, p) => {
    const quote = state.quotes[p.code];
    return sum + p.qty * (quote?.price ?? p.avgPrice);
  }, 0);
  return state.cash + holdings;
}
