/**
 * Test-only quote / paper-state helpers. Prefer these over production
 * seedQuote / createPaperState when tests need a local book without mock driver.
 */
import { clampDailyLimit, roundToTick, tickSize } from "@/lib/tick-size";
import type { AppState, Quote } from "@/lib/types";
import { findStock } from "@/lib/universe";
import { createInitialState } from "@/lib/engine";
import { CASH_RULE_ID } from "@/src/rules/params";

const HISTORY_LEN = 40;

/** Unit-test ledger funding — independent of production TOTAL_DEPOSIT (now 0). */
export const TEST_PAPER_DEPOSIT = 10_000_000;

export type TestQuoteSource = NonNullable<Quote["source"]>;

/**
 * Build a book quote for tests. Default source is "kis" so quotes are
 * orderable under live-KIS quote policy; pass source explicitly for mock/seed cases.
 */
export function makeTestQuote(
  code: string,
  prevClose = 10_000,
  name?: string,
  source: TestQuoteSource = "kis",
): Quote {
  const stock = findStock(code);
  const price = roundToTick(stock?.prevClose ?? prevClose);
  const tick = tickSize(price);
  return {
    code,
    name: name ?? stock?.name ?? code,
    market: stock?.market ?? "KOSPI",
    price,
    prevClose: stock?.prevClose ?? price,
    open: price,
    high: price,
    low: price,
    volume: 1,
    bid: roundToTick(Math.max(tick, price - tick)),
    ask: roundToTick(price + tick),
    history: Array.from({ length: HISTORY_LEN }, () => price),
    source,
  };
}

/** Paper book fixture with consent + startup sync — does not call production seedQuote. */
export function makeTestPaperState(): AppState {
  const state = createInitialState();
  state.settings.disclaimerAccepted = true;
  state.settings.autoTrading = true;
  state.settings.ignoreMarketHours = true;
  state.settings.startingCash = TEST_PAPER_DEPOSIT;
  state.totalDeposit = TEST_PAPER_DEPOSIT;
  state.allocations = [
    {
      ruleId: CASH_RULE_ID,
      budget: TEST_PAPER_DEPOSIT,
      balance: TEST_PAPER_DEPOSIT,
      enabled: true,
      lastMessage: "test fixture deposit",
    },
  ];
  state.cash = TEST_PAPER_DEPOSIT;
  state.dayStart = { date: state.dayStart.date, equity: TEST_PAPER_DEPOSIT };
  state.equityHistory = [TEST_PAPER_DEPOSIT];
  state.quotes = {
    "005930": makeTestQuote("005930", 74_800),
    "035720": makeTestQuote("035720", 42_150),
    "247540": makeTestQuote("247540", 142_700),
  };
  state.startupSync = {
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
    recoveredOrders: 0,
    orphanedOrders: 0,
    positionChanges: 0,
    executionChanges: 0,
    message: "test fixture",
  };
  return state;
}

/**
 * Synthesize random walk prices for tests. Unlike production advanceQuotes,
 * this always mutates the book (no live-KIS short-circuit).
 */
export function advanceTestQuotes(
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
      source: q.source ?? "mock",
    };
  }
  return next;
}
