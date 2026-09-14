import { clampDailyLimit, roundToTick, tickSize } from "./tick-size";
import type { AppState, AutoCondition, DcaPlan, Quote } from "./types";
import { UNIVERSE } from "./universe";
import { getMarketClock } from "./market-hours";
import { canFillLimit } from "@/src/accounts/fills";
import {
  AGGRESSIVE_UNIVERSE,
  cashFromAllocations,
  DEFAULT_ALLOCATIONS,
  KODEX_200,
  SWING_TICKER,
  TOTAL_DEPOSIT,
} from "@/src/accounts/defaults";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker, brokerDriver } from "@/src/brokers/index";
import type { IBroker } from "@/src/brokers/IBroker";
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
      broker: brokerDriver(),
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

function watchedTickers(state: AppState): string[] {
  const codes = new Set<string>([KODEX_200, SWING_TICKER, ...AGGRESSIVE_UNIVERSE]);
  for (const seed of UNIVERSE) codes.add(seed.code);
  for (const pos of state.positions) codes.add(pos.code);
  for (const cond of state.conditions) {
    if (cond.watching) codes.add(cond.code);
  }
  for (const plan of state.dcaPlans) {
    if (plan.enabled) codes.add(plan.code);
  }
  return [...codes];
}

async function refreshLiveQuotes(box: StateBox, broker: IBroker) {
  for (const code of watchedTickers(box.current)) {
    try {
      await broker.getQuote(code);
    } catch {
      // keep the last cached quote
    }
  }
}

export async function evaluateConditions(state: AppState, nowIso: string): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box);
  const now = new Date(nowIso).getTime();

  box.current = {
    ...box.current,
    conditions: box.current.conditions.map((cond) => {
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

  for (const cond of box.current.conditions) {
    if (!cond.watching || cond.status !== "watching") continue;
    const quote = box.current.quotes[cond.code];
    if (!quote) continue;
    if (!conditionMatches(cond, quote)) continue;

    if (cond.orderPriceType === "limit" && cond.limitPrice) {
      if (!canFillLimit(cond.side, quote.price, cond.limitPrice)) continue;
    }

    const broker = root
      .forStrategy(cond.strategy ?? "Level1_Stable")
      .withSource("condition", cond.id);
    const fill =
      cond.side === "sell"
        ? await broker.sellMarket(cond.code, cond.qty)
        : cond.orderPriceType === "limit" && cond.limitPrice
          ? await broker.buyLimit(cond.code, cond.limitPrice, cond.qty * cond.limitPrice)
          : await broker.buyMarket(cond.code, cond.qty * quote.price);

    if (!fill.ok && (fill.reason ?? "").includes("미체결")) continue;

    const updatedCond: AutoCondition = fill.ok
      ? {
          ...cond,
          watching: false,
          status: "filled",
          filledAt: new Date().toISOString(),
          filledOrderId: fill.orderId,
          message: `${cond.side === "buy" ? "매수" : "매도"} ${fill.qty}주 체결`,
        }
      : {
          ...cond,
          watching: false,
          status: "rejected",
          message: fill.reason,
        };

    box.current = {
      ...box.current,
      conditions: box.current.conditions.map((c) => (c.id === cond.id ? updatedCond : c)),
    };
  }

  return box.current;
}

export async function evaluateDca(state: AppState, nowIso: string): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box);
  const now = new Date(nowIso).getTime();

  for (const plan of box.current.dcaPlans) {
    if (!plan.enabled) continue;
    if (new Date(plan.nextRunAt).getTime() > now) continue;
    const quote = box.current.quotes[plan.code];
    if (!quote) continue;

    const qty = Math.floor(plan.amountKrw / quote.price);
    const scheduled: DcaPlan = {
      ...plan,
      nextRunAt: new Date(now + plan.intervalSec * 1000).toISOString(),
      runCount: plan.runCount + 1,
    };

    if (qty < 1) {
      box.current = {
        ...box.current,
        dcaPlans: box.current.dcaPlans.map((p) =>
          p.id === plan.id
            ? { ...scheduled, lastMessage: "1주 미만이라 이번 회차는 건너뜁니다." }
            : p,
        ),
      };
      continue;
    }

    const fill = await root
      .forStrategy(plan.strategy ?? "Level1_Stable")
      .withSource("dca", plan.id)
      .buyMarket(plan.code, plan.amountKrw);

    const updatedPlan: DcaPlan = {
      ...scheduled,
      lastMessage: fill.ok ? `${fill.qty}주 적립 매수` : fill.reason,
    };

    box.current = {
      ...box.current,
      dcaPlans: box.current.dcaPlans.map((p) => (p.id === plan.id ? updatedPlan : p)),
    };
  }

  return box.current;
}

export async function tickState(state: AppState, now = new Date()): Promise<AppState> {
  const clock = getMarketClock(now);
  const box: StateBox = {
    current: {
      ...ensureUniverseQuotes(state),
      tickCount: state.tickCount + 1,
      updatedAt: clock.iso,
      settings: {
        ...state.settings,
        broker: brokerDriver(),
      },
    },
  };
  const root = createBroker(box);

  if (root.driver === "kis") {
    await refreshLiveQuotes(box, root);
  } else {
    box.current = { ...box.current, quotes: advanceQuotes(box.current.quotes) };
  }

  const tradingAllowed = box.current.settings.ignoreMarketHours || clock.open;
  if (tradingAllowed) {
    box.current = await evaluateConditions(box.current, clock.iso);
    box.current = await evaluateDca(box.current, clock.iso);
    box.current = await QuantEngine.run(box.current);
  }

  return box.current;
}

export function portfolioValue(state: AppState): number {
  const holdings = state.positions.reduce((sum, p) => {
    const quote = state.quotes[p.code];
    return sum + p.qty * (quote?.price ?? p.avgPrice);
  }, 0);
  return state.cash + holdings;
}
