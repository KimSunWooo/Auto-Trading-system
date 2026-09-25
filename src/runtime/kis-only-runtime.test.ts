/**
 * KIS-only runtime migration guards (RM / RB / RQ).
 * No live orders. Uses test-support fakes only.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createInitialState, ensureUniverseQuotes, tickState } from "@/lib/engine";
import { createBroker, BrokerNotReadyError, createBrokerForRuntime } from "@/src/brokers/index";
import { brokerDriver } from "@/src/brokers/kis-config";
import { tradingMode } from "@/src/runtime/trading-mode";
import {
  invalidateNonKisQuotes,
  isOrderableQuote,
  quoteDisplayKind,
  usesLiveKisQuotes,
} from "@/src/runtime/quote-policy";
import { FakeBroker, makeTestQuote, makeTestPaperState } from "@/src/test-support";
import { TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import type { Quote } from "@/lib/types";

test("RB2 MockBroker.ts deleted from production brokers/", () => {
  assert.equal(existsSync(path.join(process.cwd(), "src/brokers/MockBroker.ts")), false);
});

test("RB1 production brokers/index does not export MockBroker", async () => {
  const mod = await import("@/src/brokers/index");
  assert.equal("MockBroker" in mod, false);
  assert.equal(typeof mod.createBroker, "function");
  assert.equal(typeof mod.KisBroker, "function");
});

test("RB4/RB5 brokerDriver always kis; TRADING_MODE mock legacy → live_test; no MOCK_BROKER_MODE helper", () => {
  assert.equal(brokerDriver({ BROKER: "mock" }), "kis");
  assert.equal(brokerDriver({}), "kis");
  // npm test (MIRAEMAESU_TEST=1): unset TRADING_MODE → paper for FakeBroker unit tests
  assert.equal(tradingMode({}), "paper");
  assert.equal(tradingMode({ TRADING_MODE: "live_test" }), "live_test");
  assert.equal(tradingMode({ TRADING_MODE: "MOCK" }), "live_test");
  assert.equal(tradingMode({ TRADING_MODE: "mock" }), "live_test");
  assert.equal(usesLiveKisQuotes(), true);
  assert.equal(TOTAL_DEPOSIT, 0);
});

test("RM3/RM5 createBroker never falls back to local mock book", () => {
  const box = { current: createInitialState() };
  assert.throws(
    () => createBroker(box, "cash", { kisClient: { configured: false } as never }),
    (err: unknown) => err instanceof BrokerNotReadyError,
  );
  assert.equal(brokerDriver({ BROKER: "mock" }), "kis");
});

test("RM4 createBrokerForRuntime uses injected client only", () => {
  const box = { current: makeTestPaperState() };
  assert.throws(
    () =>
      createBrokerForRuntime(box, {
        kisClient: { configured: false } as never,
        persistState: async () => undefined,
      }),
    (err: unknown) =>
      err instanceof BrokerNotReadyError && err.code === "KIS_PAPER_ACCOUNT_NOT_CONNECTED",
  );
});

test("RQ4/RQ5 old mock/seed persisted quotes are dropped", () => {
  const quotes: Record<string, Quote> = {
    "005930": { ...makeTestQuote("005930"), source: "mock" },
    "035720": { ...makeTestQuote("035720"), source: "seed" },
    "000660": { ...makeTestQuote("000660"), source: "kis", freshAt: Date.now() },
  };
  const next = invalidateNonKisQuotes(quotes);
  assert.equal(next["005930"], undefined);
  assert.equal(next["035720"], undefined);
  assert.ok(next["000660"]);
  const state = ensureUniverseQuotes({ ...createInitialState(), quotes });
  assert.equal(state.quotes["005930"], undefined);
  assert.equal(state.quotes["035720"], undefined);
});

test("RQ2/RQ3/RQ6 stale or missing quote → no order", () => {
  const now = Date.now();
  const stale = makeTestQuote("005930");
  stale.source = "kis";
  stale.freshAt = now - 60_000;
  assert.equal(quoteDisplayKind(stale, { liveKis: true, now }), "STALE");
  assert.equal(isOrderableQuote(stale, { liveKis: true, now }), false);
  assert.equal(quoteDisplayKind(undefined, { liveKis: true, now }), "UNAVAILABLE");
  assert.equal(isOrderableQuote(undefined, { liveKis: true, now }), false);
});

test("RQ1 fresh KIS quote is orderable", () => {
  const now = Date.now();
  const fresh = makeTestQuote("005930");
  fresh.source = "kis";
  fresh.freshAt = now;
  assert.equal(quoteDisplayKind(fresh, { liveKis: true, now }), "KIS_LIVE");
  assert.equal(isOrderableQuote(fresh, { liveKis: true, now }), true);
});

test("RC4 no default 10M presented as broker balance on new state", () => {
  const state = createInitialState();
  assert.equal(state.totalDeposit, 0);
  assert.equal(state.cash, 0);
  assert.equal(state.kisBalance, undefined);
});

test("test-only FakeBroker preserved for safety semantics", async () => {
  const box = { current: makeTestPaperState() };
  const broker = new FakeBroker(box);
  assert.equal(broker.driver, "kis");
  const fill = await broker.buyMarket("005930", 100_000);
  assert.ok(fill.status === "filled" || fill.status === "rejected" || fill.ok);
});

test("account RuntimeScope KisClient is public-status authority (not global env)", async () => {
  const { brokerPublicStatusFromKisClient, getBrokerPublicStatus } = await import(
    "@/src/brokers/kis-config"
  );
  const { createTradingStateStore, resetTradingStateStoresForTest } = await import(
    "@/src/runtime/trading-state-store"
  );
  const { EMPTY_RULE_CONFIG } = await import("@/src/rules/params");
  resetTradingStateStoresForTest();
  const prevApp = process.env.KIS_PAPER_APP_KEY;
  const prevSecret = process.env.KIS_PAPER_APP_SECRET;
  const prevAcct = process.env.KIS_PAPER_ACCOUNT_NO;
  process.env.KIS_PAPER_APP_KEY = "env-global-app-key-xxxx";
  process.env.KIS_PAPER_APP_SECRET = "env-global-secret-xxxx";
  process.env.KIS_PAPER_ACCOUNT_NO = "12345678-01";
  try {
    const envStatus = getBrokerPublicStatus();
    assert.equal(envStatus.driver, "kis");
    assert.match(envStatus.accountMasked ?? "", /78-01/);

    const accountClient = {
      mode: "paper" as const,
      configured: true,
      liveEnabled: true,
      issues: [] as string[],
      cano: "87654321",
      productCode: "01",
    };
    const scoped = brokerPublicStatusFromKisClient(accountClient);
    assert.equal(scoped.driver, "kis");
    assert.match(scoped.accountMasked ?? "", /21-01/);
    assert.notEqual(scoped.accountMasked, envStatus.accountMasked);

    const store = createTradingStateStore({
      statePath: path.join(process.cwd(), "data", "test-runtime-scope-authority.json"),
      skipPersistUnderTest: true,
      getKisClient: () => accountClient as never,
    });
    const pub = store.toPublic(makeTestPaperState(), EMPTY_RULE_CONFIG);
    assert.equal(pub.broker.accountMasked, scoped.accountMasked);
    assert.equal(pub.runtime.brokerLink, "connected");
  } finally {
    if (prevApp === undefined) delete process.env.KIS_PAPER_APP_KEY;
    else process.env.KIS_PAPER_APP_KEY = prevApp;
    if (prevSecret === undefined) delete process.env.KIS_PAPER_APP_SECRET;
    else process.env.KIS_PAPER_APP_SECRET = prevSecret;
    if (prevAcct === undefined) delete process.env.KIS_PAPER_ACCOUNT_NO;
    else process.env.KIS_PAPER_ACCOUNT_NO = prevAcct;
    resetTradingStateStoresForTest();
  }
});

test("tickState fail-closed without KisClient — no local mock fill path", async () => {
  const next = await tickState(createInitialState());
  assert.equal(Object.keys(next.quotes).length, 0);
  // Must not invent mock prices or 10M deposit
  assert.equal(next.totalDeposit, 0);
});
