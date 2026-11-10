/**
 * Operational PAPER (database ledger) must not inherit soak controlledRun mirror gates.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import { createPaperState } from "@/lib/engine";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { nowMs, setNowMs } from "@/src/clock";
import {
  appliesControlledRunOrderGates,
  emptyControlledRun,
  preTradeGate,
  quoteHealthy,
  resumeTransientUnknownStop,
} from "@/src/runtime/controlled-run";
import { mergeLiveIntoDailyCloses } from "@/src/market-data/daily-history";
import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
  resetWorkerLockForTest,
} from "@/src/runtime/worker-lock";
import { isActiveUnknownBlocker, classifyLocalActiveOrder } from "@/src/runtime/startup-sync";
import type { Order } from "@/lib/types";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

function paperEnv(mode: "database" | "mirror") {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
  process.env.PERSISTENCE_MODE = mode;
  process.env.KIS_PAPER_APP_KEY = "paper-key";
  process.env.KIS_PAPER_APP_SECRET = "paper-secret";
  process.env.KIS_PAPER_ACCOUNT_NO = "50123456-01";
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.PAPER_POLICY_MODE;
}

afterEach(() => {
  resetWorkerLockForTest();
  delete process.env.TRADING_MODE;
  delete process.env.BROKER;
  delete process.env.KIS_MODE;
  delete process.env.ALLOW_LIVE_TRADING;
  delete process.env.PERSISTENCE_MODE;
  delete process.env.KIS_PAPER_APP_KEY;
  delete process.env.KIS_PAPER_APP_SECRET;
  delete process.env.KIS_PAPER_ACCOUNT_NO;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.PAPER_POLICY_MODE;
});

function opsState() {
  const state = createPaperState();
  state.settings.autoTrading = true;
  state.settings.disclaimerAccepted = true;
  state.allocations = [
    {
      ruleId: "r1",
      name: "r1",
      enabled: true,
      balance: 5_000_000,
      initial: 5_000_000,
      lastMessage: "",
      meta: {},
    },
  ];
  const fresh = nowMs();
  state.quotes["005930"] = {
    ...(state.quotes["005930"] ?? {
      code: "005930",
      name: "삼성전자",
      market: "KOSPI",
      price: 70_000,
      prevClose: 69_000,
      open: 69_500,
      high: 70_500,
      low: 69_000,
      volume: 1,
      bid: 69_900,
      ask: 70_100,
      history: [],
    }),
    source: "kis",
    freshAt: fresh,
    price: 70_000,
    history: Array.from({ length: 30 }, (_, i) => 60_000 + i * 100),
  };
  state.quotes["035720"] = {
    code: "035720",
    name: "카카오",
    market: "KOSPI",
    price: 40_000,
    prevClose: 39_000,
    open: 39_500,
    high: 40_500,
    low: 39_000,
    volume: 1,
    bid: 39_900,
    ask: 40_100,
    history: [],
    source: "kis",
    freshAt: fresh - 60_000,
  };
  state.kisBalance = {
    syncedAt: new Date().toISOString(),
    cash: 10_000_000,
    d2Cash: 10_000_000,
    orderableCash: 9_000_000,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: "fresh",
    message: "ok",
  };
  state.safety = {
    kind: "ok",
    tradingAllowed: true,
    quoteOk: true,
    brokerConnected: true,
    reconciliation: "synced",
    workerHealthy: true,
    blockedBuys: [],
    closedByStop: {},
  };
  state.startupSync = {
    status: "HEALTHY",
    recoveredOrders: 0,
    orphanedOrders: 0,
    positionChanges: 0,
    executionChanges: 0,
  };
  return state;
}

test("database mode: leftover controlledRun does not apply soak mirror gates", () => {
  paperEnv("database");
  const state = opsState();
  state.controlledRun = emptyControlledRun({ strategyName: "soak-legacy", symbols: ["005930"] });
  assert.equal(appliesControlledRunOrderGates(state), false);

  const gate = preTradeGate(state, { side: "buy", ticker: "005930", qty: 1 });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.blocked, /mirror|PERSISTENCE_MODE/i);

  tryAcquireWorkerLock("ops-db-gates");
  const box: StateBox = { current: state };
  const om = new OrderManager(box, { startupSyncVerified: true });
  const buy = om.canBuy("r1", 1, 70_000, "005930");
  assert.equal(buy.ok, true, buy.ok ? "" : buy.reason);
  releaseWorkerLock("ops-db-gates");
});

test("mirror mode: controlledRun still applies soak gates", () => {
  paperEnv("mirror");
  const state = opsState();
  state.controlledRun = emptyControlledRun({ strategyName: "soak", symbols: ["005930"] });
  assert.equal(appliesControlledRunOrderGates(state), true);
});

test("symbol A healthy / B stale: quoteHealthy is per-ticker", () => {
  const state = opsState();
  assert.equal(quoteHealthy(state, "005930"), true);
  assert.equal(quoteHealthy(state, "035720"), false);
});

test("ORPHANED_LOCAL past unknown is not an active blocker", () => {
  const order: Order = {
    id: "o1",
    createdAt: "2020-01-02T01:00:00.000Z",
    name: "과거",
    code: "005930",
    side: "buy",
    qty: 1,
    price: 1,
    amount: 1,
    fee: 0,
    tax: 0,
    net: 1,
    status: "unknown",
    ruleId: "r1",
    activeClass: "ORPHANED_LOCAL",
  };
  assert.equal(isActiveUnknownBlocker(order), false);
  const classified = classifyLocalActiveOrder(order, [], new Date("2026-11-10T00:00:00Z"));
  assert.equal(classified.classification, "ORPHANED_LOCAL");
});

test("resumeTransientUnknownStop preserves operator autoTrading OFF", () => {
  paperEnv("mirror");
  const state = opsState();
  state.settings.autoTrading = false;
  state.controlledRun = {
    ...emptyControlledRun({ strategyName: "soak", symbols: ["005930"] }),
    status: "stopped",
    autoStopReason: "Quote repeated failure",
  };
  state.circuit = {
    halted: true,
    kind: "soak-stop",
    reason: "Quote repeated failure",
    unknownCount: 0,
  };
  const resumed = resumeTransientUnknownStop(state);
  assert.equal(resumed.settings.autoTrading, false);
});

test("mergeLiveIntoDailyCloses without dates does not invent bars from live ticks", () => {
  assert.deepEqual(mergeLiveIntoDailyCloses([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(mergeLiveIntoDailyCloses([1, 2, 3], 4), [1, 2, 3]);
  assert.deepEqual(mergeLiveIntoDailyCloses([], 10), []);
});
