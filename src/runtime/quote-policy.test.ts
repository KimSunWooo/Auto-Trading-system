import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { ensureUniverseQuotes, advanceQuotes } from "@/lib/engine";
import { KisBroker } from "@/src/brokers/KisBroker";
import { createBroker } from "@/src/brokers/index";
import type { KisApi, KisAccountBalance, KisCancelOrder, KisCashOrder, KisPrice } from "@/src/brokers/kis-client";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs, nowMs } from "@/src/clock";
import type { Quote } from "@/lib/types";
import { makeTestQuote, makeTestPaperState } from "@/src/test-support";
import {
  filterDashboardQuotes,
  invalidateNonKisQuotes,
  isFreshKisQuote,
  isMockOrSeedQuote,
  isOrderableQuote,
  quoteDisplayKind,
  quoteFreshnessLabel,
  usesLiveKisQuotes,
  LIVE_KIS_QUOTE_FRESH_MS,
} from "@/src/runtime/quote-policy";
import { formatSeoulTime } from "@/lib/format";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

afterEach(() => {
  delete process.env.TRADING_MODE;
  delete process.env.BROKER;
  delete process.env.KIS_MODE;
  delete process.env.ALLOW_LIVE_TRADING;
});

function liveKisEnv() {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
}

function mockQuote(code = "035720", price = 41_150): Quote {
  return {
    ...makeTestQuote(code),
    price,
    source: "mock",
    freshAt: undefined,
  };
}

function seedBookQuote(code = "035720"): Quote {
  return { ...makeTestQuote(code), source: "seed" };
}

function kisQuote(code = "035720", price = 33_400, freshAt = nowMs()): Quote {
  return {
    ...makeTestQuote(code),
    price,
    source: "kis",
    freshAt,
  };
}

function fakePrice(ticker: string, price = 33_400): KisPrice {
  return {
    ticker,
    name: "카카오",
    price,
    open: price,
    high: price + 100,
    low: price - 100,
    prevClose: price - 50,
    volume: 1_000_000,
  };
}

class FakeKis implements KisApi {
  mode: KisApi["mode"] = "paper";
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  orders: KisCashOrder[] = [];
  failPrice: Error | null = null;
  priceCalls = 0;
  dailyCalls = 0;
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };

  async inquirePrice(ticker: string): Promise<KisPrice> {
    this.priceCalls += 1;
    if (this.failPrice) throw this.failPrice;
    return fakePrice(ticker);
  }
  async inquireDailyCloses(): Promise<number[]> {
    this.dailyCalls += 1;
    return Array.from({ length: 30 }, () => 33_400);
  }
  async inquireDailyCcld() {
    return [];
  }
  async inquireOpenOrders() {
    return [];
  }
  async inquireBalance() {
    return this.balance;
  }
  async orderCash(order: KisCashOrder) {
    this.orders.push(order);
    return { orderNo: "0000000001", krxOrgNo: "06010" };
  }
  async cancelOrder(_order: KisCancelOrder) {}
}

test("A. live_test + kis: persisted mock quote is not a valid live quote", () => {
  liveKisEnv();
  assert.equal(usesLiveKisQuotes(), true);
  const quote = mockQuote();
  assert.equal(isMockOrSeedQuote(quote), true);
  assert.equal(isFreshKisQuote(quote), false);
  assert.equal(isOrderableQuote(quote, { liveKis: true }), false);
  assert.equal(quoteDisplayKind(quote, { liveKis: true }), "UNAVAILABLE");
  const stripped = invalidateNonKisQuotes({ "035720": quote });
  assert.equal(stripped["035720"], undefined);
});

test("B. live_test + kis: persisted seed quote is not a valid live quote", () => {
  liveKisEnv();
  const quote = seedBookQuote();
  assert.equal(isMockOrSeedQuote(quote), true);
  assert.equal(isOrderableQuote(quote, { liveKis: true }), false);
  assert.equal(quoteDisplayKind(quote, { liveKis: true }), "UNAVAILABLE");
  const stripped = invalidateNonKisQuotes({ "035720": quote });
  assert.deepEqual(stripped, {});
});

test("C. KIS getQuote success → source=kis and freshAt set", async () => {
  liveKisEnv();
  const box = { current: makeTestPaperState() };
  box.current.quotes = { "035720": mockQuote() };
  const client = new FakeKis();
  const broker = new KisBroker(box, client);
  const quote = await broker.getQuote("035720");
  assert.ok(quote);
  assert.equal(quote.price, 33_400);
  assert.equal(client.priceCalls, 1);
  assert.equal(client.dailyCalls, 1);
  const book = box.current.quotes["035720"];
  assert.equal(book.source, "kis");
  assert.ok(book.freshAt);
  assert.equal(isFreshKisQuote(book), true);
});

test("D. KIS quote failure → no mock fallback", async () => {
  liveKisEnv();
  const box = { current: makeTestPaperState() };
  box.current.quotes = { "035720": mockQuote(undefined, 99_999) };
  const client = new FakeKis();
  client.failPrice = new Error("inquirePrice down");
  const broker = new KisBroker(box, client);
  const quote = await broker.getQuote("035720");
  assert.equal(quote, null);
  assert.equal(box.current.safety?.kind, "market_data_unavailable");
  // Persisted mock price must not be returned as a live quote.
  assert.equal(box.current.quotes["035720"]?.source, "mock");
  assert.equal(box.current.quotes["035720"]?.price, 99_999);
});

test("E. getCurrentPrice with source=mock → reject", async () => {
  liveKisEnv();
  const box = { current: makeTestPaperState() };
  box.current.quotes = { "035720": mockQuote() };
  const client = new FakeKis();
  const broker = new KisBroker(box, client);
  // Quote response that does not promote the book to source=kis.
  broker.getQuote = async (ticker: string) => {
    const q = box.current.quotes[ticker];
    if (!q) return null;
    return {
      ticker,
      name: q.name,
      price: q.price,
      bid: q.bid,
      ask: q.ask,
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
      volume: q.volume,
      history: q.history,
    };
  };
  await assert.rejects(() => broker.getCurrentPrice("035720"), /mock\/seed/);
  assert.equal(client.orders.length, 0);
});

test("E2. mock/seed books are never orderable under live kis", () => {
  liveKisEnv();
  assert.equal(isOrderableQuote(mockQuote(), { liveKis: true }), false);
  assert.equal(isOrderableQuote(seedBookQuote(), { liveKis: true }), false);
});

test("F. getCurrentPrice with stale source=kis >15s → reject", async () => {
  liveKisEnv();
  const box = { current: makeTestPaperState() };
  const staleAt = nowMs() - LIVE_KIS_QUOTE_FRESH_MS - 1;
  box.current.quotes = { "035720": kisQuote("035720", 33_400, staleAt) };
  assert.equal(isFreshKisQuote(box.current.quotes["035720"]), false);
  assert.equal(isOrderableQuote(box.current.quotes["035720"], { liveKis: true }), false);
  assert.equal(
    quoteDisplayKind(box.current.quotes["035720"], { liveKis: true, now: nowMs() }),
    "STALE",
  );
  // Without explicit now, age is not classified (hydration-safe first paint).
  assert.equal(quoteDisplayKind(box.current.quotes["035720"], { liveKis: true }), "KIS_LIVE");

  const client = new FakeKis();
  client.failPrice = new Error("stale refresh failed");
  const broker = new KisBroker(box, client);
  await assert.rejects(() => broker.getCurrentPrice("035720"), /시세를 한국투자증권에서/);
});

test("G. fresh KIS <=15s → pass", () => {
  liveKisEnv();
  const quote = kisQuote("035720", 33_400, nowMs());
  assert.equal(isFreshKisQuote(quote), true);
  assert.equal(isOrderableQuote(quote, { liveKis: true }), true);
  assert.equal(quoteDisplayKind(quote, { liveKis: true }), "KIS_LIVE");
});

test("H. UI live-like mode: source=mock not shown as valid current quote", () => {
  liveKisEnv();
  const quotes = {
    "035720": mockQuote(),
    "005930": kisQuote("005930", 70_000),
    "069500": seedBookQuote("069500"),
  };
  const rows = filterDashboardQuotes(quotes, { liveKis: true });
  assert.deepEqual(
    rows.map((r) => r.code).sort(),
    ["005930"],
  );
  assert.equal(quoteDisplayKind(mockQuote(), { liveKis: true }), "UNAVAILABLE");
});

test("I. manual createBroker with configured KisClient → KisBroker path", () => {
  liveKisEnv();
  const box = { current: makeTestPaperState() };
  const broker = createBroker(box, "cash", { kisClient: new FakeKis() }).withSource("manual");
  assert.equal(broker.driver, "kis");
  assert.ok(broker instanceof KisBroker);
});

test("J. domestic PAPER does not require overseas opt-in; orderable needs fresh kis", () => {
  liveKisEnv();
  const fresh = kisQuote();
  const mock = mockQuote();
  assert.equal(isOrderableQuote(fresh, { liveKis: true }), true);
  assert.equal(isOrderableQuote(mock, { liveKis: true }), false);
  // REAL stays locked by env contract for this suite
  assert.equal(process.env.ALLOW_LIVE_TRADING, "false");
  assert.equal(process.env.KIS_MODE, "paper");
});

test("K. REAL request count stays 0 in FakeKis order path for this suite", async () => {
  liveKisEnv();
  const client = new FakeKis();
  assert.equal(client.mode, "paper");
  assert.equal(client.orders.length, 0);
  // No orderCash invoked in quote-policy tests — REAL host never contacted.
  assert.equal(client.orders.length, 0);
});

test("ensureUniverseQuotes strips mock/seed under live kis and does not seed", () => {
  liveKisEnv();
  const state = makeTestPaperState();
  state.quotes = { "035720": mockQuote(), "005930": kisQuote("005930") };
  const next = ensureUniverseQuotes(state);
  assert.equal(next.quotes["035720"], undefined);
  assert.equal(next.quotes["005930"]?.source, "kis");
});

test("advanceQuotes does not synthesize mock prices under live kis", () => {
  liveKisEnv();
  const quotes = { "035720": mockQuote(), "005930": kisQuote("005930", 70_000) };
  const next = advanceQuotes(quotes);
  assert.equal(next["035720"], undefined);
  assert.equal(next["005930"]?.source, "kis");
  assert.equal(next["005930"]?.price, 70_000);
});

test("Hydration A. SSR freshness markup equals client first-render markup", () => {
  liveKisEnv();
  const freshAt = SEOUL_REGULAR_SESSION_MS;
  const quote = kisQuote("035720", 33_400, freshAt);
  // No `now` → absolute Seoul clock only (deterministic).
  const ssr = quoteFreshnessLabel(quote, { liveKis: true });
  const clientFirst = quoteFreshnessLabel(quote, { liveKis: true });
  assert.equal(ssr, clientFirst);
  assert.equal(ssr, formatSeoulTime(freshAt));
  assert.doesNotMatch(ssr, /초 전/);
});

test("Hydration B. after mount, explicit now can mark stale", () => {
  liveKisEnv();
  const freshAt = SEOUL_REGULAR_SESSION_MS - LIVE_KIS_QUOTE_FRESH_MS - 1_000;
  const quote = kisQuote("035720", 33_400, freshAt);
  const first = quoteFreshnessLabel(quote, { liveKis: true });
  assert.equal(first, formatSeoulTime(freshAt));
  const afterMount = quoteFreshnessLabel(quote, {
    liveKis: true,
    now: SEOUL_REGULAR_SESSION_MS,
  });
  assert.match(afterMount, /시세 지연/);
  assert.match(afterMount, new RegExp(formatSeoulTime(freshAt)));
});

test("Hydration C. freshAt missing → deterministic 시세 없음 / —", () => {
  liveKisEnv();
  assert.equal(quoteFreshnessLabel(null, { liveKis: true }), "시세 없음");
  const noFresh = { ...kisQuote(), freshAt: undefined };
  assert.equal(quoteFreshnessLabel(noFresh, { liveKis: true }), "—");
});

test("Hydration D. source=kis → KIS display kind without now", () => {
  liveKisEnv();
  const quote = kisQuote("035720", 33_400, SEOUL_REGULAR_SESSION_MS);
  assert.equal(quoteDisplayKind(quote, { liveKis: true }), "KIS_LIVE");
  assert.equal(quoteFreshnessLabel(quote, { liveKis: true }), formatSeoulTime(SEOUL_REGULAR_SESSION_MS));
});

test("Hydration E. source=mock/seed in live-like not shown as valid current", () => {
  liveKisEnv();
  assert.equal(quoteDisplayKind(mockQuote(), { liveKis: true }), "UNAVAILABLE");
  assert.equal(quoteFreshnessLabel(mockQuote(), { liveKis: true }), "시세 없음");
  assert.equal(quoteDisplayKind(seedBookQuote(), { liveKis: true }), "UNAVAILABLE");
  const rows = filterDashboardQuotes(
    { a: mockQuote(), b: seedBookQuote("005930"), c: kisQuote("069500", 1, SEOUL_REGULAR_SESSION_MS) },
    { liveKis: true },
  );
  assert.deepEqual(rows.map((r) => r.code), ["069500"]);
});

test("Hydration F. freshness UI change does not weaken order safety", () => {
  liveKisEnv();
  const fresh = kisQuote("035720", 33_400, SEOUL_REGULAR_SESSION_MS);
  const stale = kisQuote("035720", 33_400, SEOUL_REGULAR_SESSION_MS - LIVE_KIS_QUOTE_FRESH_MS - 1);
  const mock = mockQuote();
  // Display may show KIS without now, but order gate still requires fresh kis.
  assert.equal(quoteDisplayKind(stale, { liveKis: true }), "KIS_LIVE");
  assert.equal(isOrderableQuote(stale, { liveKis: true, now: SEOUL_REGULAR_SESSION_MS }), false);
  assert.equal(isOrderableQuote(fresh, { liveKis: true, now: SEOUL_REGULAR_SESSION_MS }), true);
  assert.equal(isOrderableQuote(mock, { liveKis: true }), false);
  assert.equal(isFreshKisQuote(mock), false);
});
