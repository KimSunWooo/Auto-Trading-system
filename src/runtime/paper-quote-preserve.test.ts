/**
 * Stale-quote preservation, ord_psbl_cash gate, orphan history, soak auto-stop isolation.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { evaluateConditions, evaluateDca, createPaperState } from "@/lib/engine";
import { OrderManager } from "@/src/accounts/OrderManager";
import type { StateBox } from "@/src/accounts/StateBox";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { nowMs, setNowMs } from "@/src/clock";
import { FakeBroker } from "@/src/test-support";
import { RiskManager } from "@/src/risk/RiskManager";
import { isActiveWorkingOrder } from "@/src/risk/order-policy";
import {
  appliesControlledRunOrderGates,
  autoStopReason,
  emptyControlledRun,
} from "@/src/runtime/controlled-run";
import { tryAcquireWorkerLock, releaseWorkerLock, resetWorkerLockForTest } from "@/src/runtime/worker-lock";
import type { AutoCondition, DcaPlan, Order } from "@/lib/types";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));
afterEach(() => {
  resetWorkerLockForTest();
  delete process.env.TRADING_MODE;
  delete process.env.BROKER;
  delete process.env.KIS_MODE;
  delete process.env.ALLOW_LIVE_TRADING;
  delete process.env.PERSISTENCE_MODE;
  delete process.env.PAPER_POLICY_MODE;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
});

function liveEnv(mode: "database" | "mirror" = "database") {
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
  process.env.PERSISTENCE_MODE = mode;
}

function withQuotes(freshA: boolean, freshB: boolean) {
  const state = createPaperState();
  state.settings.autoTrading = true;
  state.settings.disclaimerAccepted = true;
  const t = nowMs();
  state.quotes["005930"] = {
    ...state.quotes["005930"]!,
    source: "kis",
    freshAt: freshA ? t : t - 60_000,
    price: 70_000,
  };
  state.quotes["035720"] = {
    ...state.quotes["035720"]!,
    source: "kis",
    freshAt: freshB ? t : t - 60_000,
    price: 40_000,
  };
  state.kisBalance = {
    syncedAt: new Date(t).toISOString(),
    fetchedAt: new Date(t).toISOString(),
    cash: 10_000_000,
    d2Cash: 10_000_000,
    orderableCash: 9_000_000,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: "fresh",
    message: "ok",
  };
  return state;
}

test("stale B keeps watching; fresh A can still match without touching B", async () => {
  liveEnv("database");
  tryAcquireWorkerLock("cond-ab");
  const state = withQuotes(true, false);
  const expires = new Date(nowMs() + 86_400_000).toISOString();
  const condA: AutoCondition = {
    id: "cond-a",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    watchBasis: "last",
    operator: "lte",
    triggerPrice: 80_000,
    volumeEnabled: false,
    volumeOp: "gte",
    volume: 0,
    qty: 1,
    watching: true,
    status: "watching",
    createdAt: new Date(nowMs()).toISOString(),
    expiresAt: expires,
    orderPriceType: "market",
    limitPrice: null,
    ruleId: "cash",
    message: "",
  };
  const condB: AutoCondition = {
    id: "cond-b",
    code: "035720",
    name: "카카오",
    side: "buy",
    watchBasis: "last",
    operator: "lte",
    triggerPrice: 50_000,
    volumeEnabled: false,
    volumeOp: "gte",
    volume: 0,
    qty: 1,
    watching: true,
    status: "watching",
    createdAt: new Date(nowMs()).toISOString(),
    expiresAt: expires,
    orderPriceType: "market",
    limitPrice: null,
    ruleId: "cash",
    message: "",
  };
  state.conditions = [condA, condB];
  const next = await evaluateConditions(state, new Date(nowMs()).toISOString(), {
    createTestBroker: (box) => new FakeBroker(box),
  });
  const a = next.conditions.find((c) => c.id === "cond-a")!;
  const b = next.conditions.find((c) => c.id === "cond-b")!;
  assert.equal(b.watching, true);
  assert.equal(b.status, "watching");
  assert.match(b.message ?? "", /시세 만료.*감시 유지/);
  // A matched and FakeBroker filled → watching cleared
  assert.equal(a.watching, false);
  assert.ok(a.status === "filled" || a.status === "paused" || a.status === "rejected");
  releaseWorkerLock("cond-ab");
});

test("DCA stale quote preserves runCount and nextRunAt", async () => {
  liveEnv("database");
  tryAcquireWorkerLock("dca-stale");
  const state = withQuotes(false, true);
  const nextAt = new Date(nowMs() - 1_000).toISOString();
  const plan: DcaPlan = {
    id: "dca-1",
    code: "005930",
    name: "삼성전자",
    amountKrw: 100_000,
    intervalSec: 86_400,
    enabled: true,
    nextRunAt: nextAt,
    runCount: 3,
    createdAt: new Date(nowMs()).toISOString(),
    ruleId: "cash",
    lastMessage: "",
  };
  state.dcaPlans = [plan];
  const next = await evaluateDca(state, new Date(nowMs()).toISOString(), {
    createTestBroker: (box) => new FakeBroker(box),
  });
  const updated = next.dcaPlans[0]!;
  assert.equal(updated.runCount, 3);
  assert.equal(updated.nextRunAt, nextAt);
  assert.match(updated.lastMessage ?? "", /시세 만료.*DCA 회차 유지/);
  releaseWorkerLock("dca-stale");
});

test("ord_psbl_cash insufficient → canBuy false before begin (no ghost pending)", () => {
  liveEnv("database");
  tryAcquireWorkerLock("ord-psbl");
  const state = withQuotes(true, true);
  state.kisBalance = {
    ...state.kisBalance!,
    orderableCash: 1_000,
  };
  state.allocations = [
    { ruleId: "cash", budget: 5_000_000, balance: 5_000_000, enabled: true },
  ];
  const box: StateBox = { current: state };
  const om = new OrderManager(box, { startupSyncVerified: true });
  const gate = om.canBuy("cash", 1, 70_000, "005930");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /주문가능금액/);
  assert.equal(box.current.orders.length, 0);
  releaseWorkerLock("ord-psbl");
});

test("ORPHANED_LOCAL working history does not block canBuy", () => {
  liveEnv("database");
  tryAcquireWorkerLock("orphan-work");
  const state = withQuotes(true, true);
  state.allocations = [
    { ruleId: "cash", budget: 5_000_000, balance: 5_000_000, enabled: true },
  ];
  const orphan: Order = {
    id: "old",
    createdAt: "2020-01-01T00:00:00.000Z",
    source: "rule",
    name: "과거",
    code: "005930",
    side: "buy",
    qty: 1,
    price: 1,
    amount: 1,
    commission: 0,
    tax: 0,
    net: 1,
    status: "unknown",
    ruleId: "cash",
    activeClass: "ORPHANED_LOCAL",
  };
  state.orders = [orphan];
  assert.equal(isActiveWorkingOrder(orphan, { ruleId: "cash", ticker: "005930", side: "buy" }), false);
  const box: StateBox = { current: state };
  const om = new OrderManager(box, { startupSyncVerified: true });
  const gate = om.canBuy("cash", 1, 70_000, "005930");
  assert.equal(gate.ok, true, gate.ok ? "" : gate.reason);
  releaseWorkerLock("orphan-work");
});

test("database leftover controlledRun does not feed autoStopReason for soak-stop", () => {
  liveEnv("database");
  tryAcquireWorkerLock("soak-auto-stop");
  const state = withQuotes(true, true);
  state.controlledRun = {
    ...emptyControlledRun({ strategyName: "legacy-soak", symbols: ["005930"] }),
    jsonRdsDivergence: 3,
  };
  assert.equal(appliesControlledRunOrderGates(state), false);
  // Raw soak reason may still compute under mirror-era helpers…
  const reason = autoStopReason(state);
  assert.equal(reason, "DB / JSON position divergence");
  // …but ops engine must ignore it via appliesControlledRunOrderGates.
  assert.equal(appliesControlledRunOrderGates(state) ? reason : null, null);
  releaseWorkerLock("soak-auto-stop");
});

test("enforceStops does not set closedByStop on rejected sell", async () => {
  liveEnv("database");
  const state = withQuotes(true, true);
  state.quotes["005930"]!.price = 70_000;
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 2, avgPrice: 100_000, ruleId: "cash" },
  ];
  const box = { current: state };
  class RejectSellBroker extends FakeBroker {
    override async sellLimit() {
      return {
        ok: false as const,
        status: "rejected" as const,
        ticker: "005930",
        side: "sell" as const,
        qty: 0,
        price: 0,
        amount: 0,
        net: 0,
        reason: "시세 만료 — 주문하지 않습니다.",
      };
    }
  }
  await new RiskManager(box).enforceStops({
    createTestBroker: (b) => new RejectSellBroker(b),
  });
  assert.equal(box.current.safety?.closedByStop?.["cash:005930"], undefined);
  assert.match(
    box.current.allocations.find((a) => a.ruleId === "cash")?.lastMessage ?? "",
    /거절|시세/,
  );
});
