import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import type { AppState, Order } from "@/lib/types";
import type { KisAccountBalance, KisApi, KisCancelOrder, KisCashOrder, KisDayOrder, KisPrice } from "@/src/brokers/kis-client";
import { tradingBlocked, resetCircuit } from "@/src/risk/circuit";
import { REAL_ORDER_POLICY, usesPaperOrderPolicy } from "@/src/risk/order-policy";
import {
  classifyLocalActiveOrder,
  emptyStartupSync,
  findActiveUnknownOrder,
  markProcessBootStartupVerified,
  resetProcessBootStartupForTest,
  runPaperStartupSync,
  startupSyncBlocksTrading,
  syncRuntimePositionsFromBroker,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
} as const;

const REAL_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live",
  KIS_MODE: "real",
  ALLOW_LIVE_TRADING: "true",
  KIS_LIVE_CONFIRM: "I_UNDERSTAND",
  KIS_REAL_APP_KEY: "real-key",
  KIS_REAL_APP_SECRET: "real-secret",
  KIS_REAL_ACCOUNT_NO: "22222222-01",
} as const;

function applyEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

function clearEnv() {
  for (const key of [
    ...Object.keys(PAPER_ENV),
    ...Object.keys(REAL_ENV),
    "KIS_LIVE_CONFIRM",
  ]) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearEnv();
  resetProcessBootStartupForTest();
});

class FakeKis implements KisApi {
  mode: KisApi["mode"] = "paper";
  configured = true;
  liveEnabled = true;
  issues: string[] = [];
  open: KisDayOrder[] = [];
  fills: KisDayOrder[] = [];
  balance: KisAccountBalance = { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };
  failOpen = false;

  async inquirePrice(ticker: string): Promise<KisPrice> {
    return {
      ticker,
      name: ticker,
      price: 70_000,
      open: 70_000,
      high: 71_000,
      low: 69_000,
      prevClose: 69_500,
      volume: 1,
    };
  }
  async inquireDailyCloses(): Promise<number[]> {
    return [];
  }
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    return this.fills.map((row) => ({ ...row }));
  }
  async inquireOpenOrders(): Promise<KisDayOrder[]> {
    if (this.failOpen) throw new Error("open orders failed");
    return this.open.map((row) => ({ ...row }));
  }
  async inquireBalance(): Promise<KisAccountBalance> {
    return {
      cash: this.balance.cash,
      d2Cash: this.balance.d2Cash,
      holdings: this.balance.holdings.map((h) => ({ ...h })),
    };
  }
  async orderCash(_order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }> {
    throw new Error("orders forbidden in startup sync tests");
  }
  async cancelOrder(_order: KisCancelOrder): Promise<void> {}
}

function parentOrder(extra: Partial<Order>): Order {
  return {
    id: extra.id ?? "ord-1",
    createdAt: extra.createdAt ?? "2026-09-15T01:00:00.000Z",
    source: extra.source ?? "rule",
    code: extra.code ?? "005930",
    name: extra.name ?? "삼성전자",
    side: extra.side ?? "buy",
    qty: extra.qty ?? 1,
    price: extra.price ?? 70_000,
    amount: extra.amount ?? 70_000,
    commission: 0,
    tax: 0,
    net: extra.net ?? 70_000,
    status: extra.status ?? "unknown",
    brokerOrderNo: extra.brokerOrderNo,
    intentId: extra.intentId,
    reason: extra.reason,
    activeClass: extra.activeClass,
    provenance: extra.provenance,
  };
}

test("Test A: yesterday pending without KIS ODNO + test provenance → ORPHANED_LOCAL, not blocked", async () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    parentOrder({
      id: "88e68d0a-edea-4443-9cc0-3d19a54b6e08",
      createdAt: "2026-09-15T01:00:00.000Z",
      qty: 11,
      brokerOrderNo: "0000000101",
      intentId: "sig:paper:dup",
      status: "unknown",
      reason: "초당 거래건수를 초과하였습니다.",
    }),
  ];
  state.startupSync = emptyStartupSync();
  const client = new FakeKis();
  client.balance.holdings = [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 }];
  const result = await runPaperStartupSync(state, client, PAPER_ENV, new Date("2026-09-17T08:00:00.000Z"));
  assert.equal(result.ok, true);
  const order = result.state.orders.find((row) => row.id === "88e68d0a-edea-4443-9cc0-3d19a54b6e08");
  assert.equal(order?.activeClass, "ORPHANED_LOCAL");
  assert.ok(order);
  assert.equal(findActiveUnknownOrder(result.state), undefined);
  markProcessBootStartupVerified(true);
  assert.equal(startupSyncBlocksTrading(result.state, PAPER_ENV), null);
  assert.equal(tradingBlocked(result.state), null);
  const reset = resetCircuit(result.state);
  assert.equal(reset.error, undefined);
});

test("Test B: today pending without ODNO → UNKNOWN_ACTIVE blocks trading", async () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    parentOrder({
      id: "today-unknown",
      createdAt: "2026-09-17T01:00:00.000Z",
      status: "pending",
      brokerOrderNo: undefined,
      intentId: "sig:live:today",
    }),
  ];
  const client = new FakeKis();
  client.balance.holdings = [];
  const result = await runPaperStartupSync(state, client, PAPER_ENV, new Date("2026-09-17T08:00:00.000Z"));
  assert.equal(result.ok, false);
  const order = result.state.orders.find((row) => row.id === "today-unknown");
  assert.equal(order?.activeClass, "UNKNOWN_ACTIVE");
  assert.ok(findActiveUnknownOrder(result.state));
  assert.match(startupSyncBlocksTrading(result.state, PAPER_ENV) ?? "", /FAILED|미확인|차단/);
});

test("Test C: local unknown + KIS exact ODNO → recovered ACTIVE_MATCHED", async () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    parentOrder({
      id: "link-me",
      createdAt: "2026-09-17T01:00:00.000Z",
      status: "unknown",
      brokerOrderNo: "0000000999",
      qty: 1,
    }),
  ];
  const client = new FakeKis();
  client.open = [
    {
      orderNo: "0000000999",
      ticker: "005930",
      side: "buy",
      qty: 1,
      filledQty: 0,
      unfilledQty: 1,
      avgPrice: 70_000,
    },
  ];
  client.balance.holdings = [];
  const result = await runPaperStartupSync(state, client, PAPER_ENV, new Date("2026-09-17T08:00:00.000Z"));
  assert.equal(result.ok, true);
  const order = result.state.orders.find((row) => row.id === "link-me");
  assert.equal(order?.activeClass, "ACTIVE_MATCHED");
  assert.equal(order?.status, "pending");
});

test("Test D: KIS position exists, local missing → recovered", () => {
  const state = createPaperState();
  state.positions = [];
  const synced = syncRuntimePositionsFromBroker(state, {
    cash: 1,
    d2Cash: 1,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 }],
  });
  assert.equal(synced.changes, 1);
  assert.equal(synced.state.positions[0]?.qty, 1);
  assert.equal(synced.state.positions[0]?.code, "005930");
});

test("Test E: local active position, KIS missing → runtime follows KIS", () => {
  const state = createPaperState();
  state.positions = [
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 100_000, ruleId: "cash" },
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 253500, ruleId: "cash" },
  ];
  const synced = syncRuntimePositionsFromBroker(state, {
    cash: 1,
    d2Cash: 1,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 }],
  });
  assert.ok(synced.changes >= 1);
  assert.equal(synced.state.positions.some((p) => p.code === "069500"), false);
  assert.equal(synced.state.positions.find((p) => p.code === "005930")?.qty, 1);
});

test("Test F: historical orders remain stored after sync", async () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.orders = [
    parentOrder({
      id: "hist-1",
      createdAt: "2026-09-15T01:00:00.000Z",
      status: "unknown",
      brokerOrderNo: "0000000101",
      intentId: "sig:paper:dup",
    }),
    parentOrder({
      id: "filled-keep",
      createdAt: "2026-09-17T03:20:02.727Z",
      status: "filled",
      brokerOrderNo: "0000022105",
      qty: 1,
    }),
  ];
  const before = state.orders.length;
  const client = new FakeKis();
  client.balance.holdings = [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 }];
  const result = await runPaperStartupSync(state, client, PAPER_ENV, new Date("2026-09-17T08:00:00.000Z"));
  assert.equal(result.state.orders.length, before);
  assert.ok(result.state.orders.find((row) => row.id === "hist-1"));
  assert.ok(result.state.orders.find((row) => row.id === "filled-keep"));
});

test("Test G: startup sync FAILED → no order", async () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.startupSync = { ...emptyStartupSync(), status: "FAILED", message: "open orders failed" };
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /FAILED|차단/);
  assert.match(tradingBlocked(state) ?? "", /FAILED|차단|Startup/);
});

test("Test H: startup sync HEALTHY → normal PAPER trading allowed", () => {
  applyEnv(PAPER_ENV);
  markProcessBootStartupVerified(true);
  const state = createPaperState();
  state.startupSync = {
    ...emptyStartupSync(),
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
  };
  assert.equal(startupSyncBlocksTrading(state, PAPER_ENV), null);
});

test("R1: persisted HEALTHY without process boot verify still blocks trading", () => {
  applyEnv(PAPER_ENV);
  markProcessBootStartupVerified(false);
  const state = createPaperState();
  state.startupSync = {
    ...emptyStartupSync(),
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
  };
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /Process boot|Startup Sync/);
});

test("Test I: REAL policy unchanged / startup sync not applied", () => {
  assert.equal(usesPaperStartupSync(REAL_ENV), false);
  assert.equal(usesPaperOrderPolicy(REAL_ENV), false);
  assert.equal(REAL_ORDER_POLICY.enforceAmountCaps, true);
  const state = createPaperState();
  assert.equal(startupSyncBlocksTrading(state, REAL_ENV), null);
});

test("classify problem order 88e68d0a as ORPHANED_LOCAL", () => {
  const order = parentOrder({
    id: "88e68d0a-edea-4443-9cc0-3d19a54b6e08",
    createdAt: "2026-09-15T01:00:00.000Z",
    brokerOrderNo: "0000000101",
    intentId: "sig:paper:dup",
    status: "unknown",
    qty: 11,
  });
  const result = classifyLocalActiveOrder(order, [], new Date("2026-09-17T08:00:00.000Z"));
  assert.equal(result.classification, "ORPHANED_LOCAL");
});

test("IDLE startup sync blocks PAPER trading before first sync", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.startupSync = emptyStartupSync();
  assert.match(startupSyncBlocksTrading(state, PAPER_ENV) ?? "", /Startup Sync/);
});
