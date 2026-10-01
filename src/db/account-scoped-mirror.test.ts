/**
 * Account-scoped durable mirror regression.
 * MemoryLedger only — no live RDS, no broker orders.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { failingLedger, MemoryLedger } from "@/src/db/ledger";
import { projectAppState } from "@/src/db/projector";
import { mirrorAfterJsonSave, setMirrorLedgerForTest } from "@/src/db/mirror";
import { resetDatabaseStatusForTest, snapshotDatabaseStatus } from "@/src/db/status";
import { CASH_RULE_ID } from "@/src/rules/params";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { stableId } from "@/src/db/ids";
import { instrumentIdFor } from "@/src/db/mapping";
import { money } from "@/src/db/money";
import type { AppState, Order } from "@/lib/types";
import { createTradingStateStore } from "@/src/runtime/trading-state-store";
import { DatabaseLedgerError, persistTradingLedger } from "@/src/db/persist";

const PREV_MODE = process.env.PERSISTENCE_MODE;
const PREV_URL = process.env.DATABASE_URL;
const PREV_OWNER = process.env.PAPER_RUNTIME_OWNER;
const MASTER = "test-broker-credential-master-key-32chars!!";
const ACTIVE_ID = "e3152ebd-c8f5-432f-8923-287d3163e79c";
const OTHER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID = "ff8b3224-5330-46b2-a7a4-481791a4824f";
const OTHER_USER = "11111111-2222-3333-4444-555555555555";
const RULE_ID = "5b0e2bde-25e1-4752-9c22-6e7920187cf6";

before(() => {
  process.env.PERSISTENCE_MODE = "mirror";
  process.env.PAPER_RUNTIME_OWNER = "accounts";
  process.env.BROKER_CREDENTIAL_MASTER_KEY = MASTER;
  delete process.env.DATABASE_URL;
  setMirrorLedgerForTest(null);
  resetDatabaseStatusForTest();
});

after(() => {
  if (PREV_MODE == null) delete process.env.PERSISTENCE_MODE;
  else process.env.PERSISTENCE_MODE = PREV_MODE;
  if (PREV_URL == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREV_URL;
  if (PREV_OWNER == null) delete process.env.PAPER_RUNTIME_OWNER;
  else process.env.PAPER_RUNTIME_OWNER = PREV_OWNER;
  setMirrorLedgerForTest(null);
  resetDatabaseStatusForTest();
});

function paperEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROKER: "kis",
    KIS_MODE: "paper",
    TRADING_MODE: "live_test",
    ALLOW_LIVE_TRADING: "false",
    PERSISTENCE_MODE: "mirror",
    PAPER_RUNTIME_OWNER: "accounts",
    BROKER_CREDENTIAL_MASTER_KEY: MASTER,
    KIS_PAPER_ACCOUNT_NO: "50206021",
    ...extra,
  };
}

function seedActiveAccount(ledger: MemoryLedger, id: string, userId: string, cano: string): void {
  const fp = paperPhysicalAccountFingerprint(cano);
  ledger.snapshot.users.set(userId, {
    id: userId,
    email: `${userId}@test.local`,
    displayName: "test",
    role: "USER",
    status: "ACTIVE",
    createdAt: "2026-01-01 00:00:00.000000",
    updatedAt: "2026-01-01 00:00:00.000000",
  });
  ledger.snapshot.brokerAccounts.set(id, {
    id,
    userId,
    broker: "KIS",
    environment: "PAPER",
    displayName: "KIS PAPER",
    accountNumberMasked: `****${cano.slice(-4)}`,
    baseCurrency: "KRW",
    status: "ACTIVE",
    isDefault: true,
    credentialRef: null,
    physicalAccountFingerprint: fp,
  });
}

function seedLedgerOrder(
  ledger: MemoryLedger,
  accountId: string,
  localOrderId: string,
  odno: string,
  ruleKey: string,
): void {
  const instrumentId = instrumentIdFor("005930");
  ledger.snapshot.instruments.set(instrumentId, {
    id: instrumentId,
    country: "KR",
    market: "KOSPI",
    symbol: "005930",
    displayName: "삼성전자",
    koreanName: "삼성전자",
    englishName: null,
    currency: "KRW",
    kisExchangeCode: "KRX",
    instrumentType: "STOCK",
    isActive: true,
  });
  const orderId = stableId("order", `${accountId}:${localOrderId}`);
  ledger.snapshot.orders.set(orderId, {
    id: orderId,
    brokerAccountId: accountId,
    instrumentId,
    intentId: null,
    localOrderId,
    brokerOrderNo: odno,
    brokerOrderDate: "20260917",
    brokerOrgNo: null,
    side: "BUY",
    orderType: "LIMIT",
    requestedQty: money(1),
    requestedPrice: money(70_000),
    filledQty: money(1),
    remainingQty: money(0),
    averageFillPrice: money(70_000),
    currency: "KRW",
    status: "FILLED",
    source: "SEED",
    sourceId: null,
    ruleKey,
    reason: "pre-seed",
    submittedAt: "2026-09-17 00:00:00.000000",
    acceptedAt: "2026-09-17 00:00:00.000000",
    completedAt: "2026-09-17 00:00:00.000000",
    createdAt: "2026-09-17 00:00:00.000000",
    updatedAt: "2026-09-17 00:00:00.000000",
  });
  const posId = stableId("position", `${accountId}:${instrumentId}:${ruleKey}`);
  ledger.snapshot.positions.set(posId, {
    id: posId,
    brokerAccountId: accountId,
    instrumentId,
    ruleScope: ruleKey,
    quantity: money(1),
    availableQuantity: money(1),
    averagePrice: money(70_000),
    totalCost: money(70_000),
    marketPrice: money(70_000),
    marketValue: money(70_000),
    unrealizedPnl: money(0),
    unrealizedReturnPct: null,
    currency: "KRW",
    provenance: "RUNTIME",
    updatedAt: "2026-09-17 00:00:00.000000",
  });
}

function filledBuy(partial: Partial<Order> & Pick<Order, "id" | "code" | "qty" | "price">): Order {
  return {
    createdAt: "2026-10-01T04:46:23.383Z",
    source: "rule",
    ruleId: CASH_RULE_ID,
    name: partial.code,
    side: "buy",
    amount: partial.qty * partial.price,
    commission: 0,
    tax: 0,
    net: partial.qty * partial.price,
    status: "filled",
    orderedQty: partial.qty,
    filledQty: partial.qty,
    brokerOrderNo: partial.brokerOrderNo ?? "0000027577",
    ...partial,
  };
}

test("account-scoped mirror attributes orders/execs/positions to ACTIVE account only", async () => {
  const ledger = new MemoryLedger();
  seedActiveAccount(ledger, ACTIVE_ID, USER_ID, "50206021");
  seedActiveAccount(ledger, OTHER_ID, OTHER_USER, "50111222");
  seedLedgerOrder(ledger, OTHER_ID, "other-preseed", "0000091111", "other-rule");

  // DISABLED bootstrap row with its own preseed — must stay untouched.
  const bootstrapId = stableId("broker-account", `${USER_ID}:KIS:PAPER`);
  ledger.snapshot.brokerAccounts.set(bootstrapId, {
    id: bootstrapId,
    userId: USER_ID,
    broker: "KIS",
    environment: "PAPER",
    displayName: "bootstrap",
    accountNumberMasked: "****6021",
    baseCurrency: "KRW",
    status: "DISABLED",
    isDefault: false,
    credentialRef: null,
    physicalAccountFingerprint: null,
  });
  seedLedgerOrder(ledger, bootstrapId, "boot-preseed", "0000092222", "boot-rule");

  const otherOrdersBefore = [...ledger.snapshot.orders.values()].filter(
    (o) => o.brokerAccountId === OTHER_ID,
  );
  const bootOrdersBefore = [...ledger.snapshot.orders.values()].filter(
    (o) => o.brokerAccountId === bootstrapId,
  );
  assert.equal(otherOrdersBefore.length, 1);
  assert.equal(bootOrdersBefore.length, 1);

  const state = createPaperState();
  state.settings.autoTrading = false;
  const parent = filledBuy({
    id: "live-069500-1",
    code: "069500",
    name: "KODEX 200",
    qty: 1,
    price: 110_562,
    brokerOrderNo: "0000027577",
    intentId: "sig:interval:rule:069500:1",
    ruleId: RULE_ID,
  });
  const fillChild: Order = {
    ...parent,
    id: "live-069500-1-fill",
    parentOrderId: parent.id,
    createdAt: "2026-10-01T04:46:26.403Z",
  };
  state.orders = [fillChild, parent];
  state.intents = [
    {
      intentId: "sig:interval:rule:069500:1",
      signalId: "sig:interval:rule:069500:1",
      ruleId: RULE_ID,
      ticker: "069500",
      side: "buy",
      qty: 1,
      price: 110_562,
      createdAt: parent.createdAt,
      reason: "interval-buy",
      status: "filled",
      orderId: parent.id,
      brokerOrderNo: parent.brokerOrderNo,
    },
  ];
  state.positions = [
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 110_562, ruleId: CASH_RULE_ID },
  ];

  const result = await projectAppState(ledger, state, {
    brokerAccountId: ACTIVE_ID,
    env: paperEnv(),
  });
  assert.equal(result.brokerAccountId, ACTIVE_ID);
  assert.equal(result.imported.orders, 1);
  assert.equal(result.imported.executions, 1);
  assert.ok(result.imported.intents >= 1);

  const activeOrders = [...ledger.snapshot.orders.values()].filter(
    (o) => o.brokerAccountId === ACTIVE_ID,
  );
  const activeExecs = [...ledger.snapshot.executions.values()].filter(
    (e) => e.brokerAccountId === ACTIVE_ID,
  );
  const activeIntents = [...ledger.snapshot.intents.values()].filter(
    (i) => i.brokerAccountId === ACTIVE_ID,
  );
  assert.equal(activeOrders.length, 1);
  assert.equal(activeOrders[0]?.ruleKey, RULE_ID);
  assert.equal(activeOrders[0]?.brokerOrderNo, "0000027577");
  assert.equal(activeExecs.length, 1);
  assert.equal(activeIntents[0]?.ruleKey, RULE_ID);
  assert.equal(activeIntents[0]?.intentKey, "sig:interval:rule:069500:1");

  const activeAccount = ledger.snapshot.brokerAccounts.get(ACTIVE_ID);
  assert.equal(activeAccount?.userId, USER_ID);
  assert.equal(activeAccount?.status, "ACTIVE");

  // Other account + bootstrap ledger rows preserved bit-for-bit (same ids / ODNO).
  const otherAfter = [...ledger.snapshot.orders.values()].filter((o) => o.brokerAccountId === OTHER_ID);
  const bootAfter = [...ledger.snapshot.orders.values()].filter((o) => o.brokerAccountId === bootstrapId);
  assert.equal(otherAfter.length, otherOrdersBefore.length);
  assert.equal(otherAfter[0]?.id, otherOrdersBefore[0]?.id);
  assert.equal(otherAfter[0]?.brokerOrderNo, "0000091111");
  assert.equal(bootAfter.length, bootOrdersBefore.length);
  assert.equal(bootAfter[0]?.id, bootOrdersBefore[0]?.id);
  assert.equal(bootAfter[0]?.brokerOrderNo, "0000092222");
  assert.equal(ledger.snapshot.brokerAccounts.get(bootstrapId)?.status, "DISABLED");
});

test("account-scoped re-projection does not duplicate orders/executions", async () => {
  const ledger = new MemoryLedger();
  seedActiveAccount(ledger, ACTIVE_ID, USER_ID, "50206021");
  const state = createPaperState();
  state.settings.autoTrading = false;
  state.orders = [
    filledBuy({
      id: "idem-parent",
      code: "069500",
      qty: 1,
      price: 110_000,
      brokerOrderNo: "0000028353",
      ruleId: RULE_ID,
    }),
  ];
  state.positions = [
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 110_000, ruleId: CASH_RULE_ID },
  ];

  const first = await projectAppState(ledger, state, {
    brokerAccountId: ACTIVE_ID,
    env: paperEnv(),
  });
  const second = await projectAppState(ledger, state, {
    brokerAccountId: ACTIVE_ID,
    env: paperEnv(),
  });
  assert.equal(first.imported.orders, 1);
  assert.equal(first.imported.executions, 1);
  assert.equal(second.imported.orders, 0);
  assert.equal(second.imported.executions, 0);
  assert.equal(
    [...ledger.snapshot.orders.values()].filter((o) => o.brokerAccountId === ACTIVE_ID).length,
    1,
  );
  assert.equal(
    [...ledger.snapshot.executions.values()].filter((e) => e.brokerAccountId === ACTIVE_ID).length,
    1,
  );
});

test("mirror failure keeps JSON; persist retry does not broker-resubmit", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acct-mirror-fail-"));
  const statePath = path.join(dir, "state.json");
  try {
    const initial = createPaperState();
    initial.settings.autoTrading = false;
    writeFileSync(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

    setMirrorLedgerForTest(failingLedger("forced mirror failure"));
    process.env.PERSISTENCE_MODE = "mirror";
    const store = createTradingStateStore({
      statePath,
      brokerAccountId: ACTIVE_ID,
      skipPersistUnderTest: false,
    });

    // KisBroker-shaped counter: only increments on explicit broker submit.
    let brokerSubmitCalls = 0;

    const next = await store.mutateStore(async (state) => ({
      ...state,
      settings: { ...state.settings, autoTrading: false },
      tickCount: state.tickCount + 1,
    }));
    assert.equal(next.settings.autoTrading, false);

    // Recovery / re-persist after degrade — must not call broker submit.
    await store.persistStateNow(await store.getState());
    assert.equal(
      brokerSubmitCalls,
      0,
      "persist/retry after mirror degrade must not auto-submit broker orders",
    );
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as AppState;
    assert.equal(onDisk.tickCount, next.tickCount);
    assert.equal(onDisk.settings.autoTrading, false);

    const status = snapshotDatabaseStatus({ enabled: true, mode: "mirror" });
    assert.ok(status.lastError);
    assert.match(status.lastError, /forced mirror failure|DB_MIRROR_DEGRADED|mirror/i);
  } finally {
    setMirrorLedgerForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("database-mode ledger failure blocks KisBroker pre-submit (0 orderCash)", async () => {
  const { KisBroker } = await import("@/src/brokers/KisBroker");
  const { SEOUL_REGULAR_SESSION_MS } = await import("@/lib/market-hours");
  const { setNowMs } = await import("@/src/clock");
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  try {
    let orderCashCalls = 0;
    const client = {
      mode: "paper" as const,
      configured: true,
      liveEnabled: true,
      issues: [] as string[],
      async inquirePrice(ticker: string) {
        return {
          ticker,
          name: ticker,
          price: 70_000,
          open: 70_000,
          high: 70_000,
          low: 70_000,
          prevClose: 70_000,
          volume: 1,
        };
      },
      async inquireDailyCloses() {
        return Array.from({ length: 30 }, () => 70_000);
      },
      async inquireDailyCcld() {
        return [];
      },
      async inquireOpenOrders() {
        return [];
      },
      async inquireBalance() {
        return { cash: 10_000_000, d2Cash: 10_000_000, holdings: [] };
      },
      async orderCash() {
        orderCashCalls += 1;
        return { orderNo: "SHOULD-NOT-FIRE", krxOrgNo: "x" };
      },
      async cancelOrder() {},
    };
    const box = { current: createPaperState() };
    box.current.settings.autoTrading = true;
    box.current.settings.disclaimerAccepted = true;
    box.current.settings.ignoreMarketHours = true;
    const broker = new KisBroker(box, client, CASH_RULE_ID, "rule", undefined, undefined, {
      persistState: async () => {
        throw new DatabaseLedgerError("db authority down");
      },
    });
    const fill = await broker.buyMarket("005930", 70_000);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /DB intent\/ledger 저장 실패|DB/);
    assert.equal(orderCashCalls, 0, "KisBroker must not call orderCash after DatabaseLedgerError");
  } finally {
    setNowMs(null);
  }
});

test("mirrorAfterJsonSave with brokerAccountId is a no-op in json mode (no broker)", async () => {
  const ledger = new MemoryLedger();
  seedActiveAccount(ledger, ACTIVE_ID, USER_ID, "50206021");
  setMirrorLedgerForTest(ledger);
  process.env.PERSISTENCE_MODE = "json";
  const state = createPaperState();
  state.settings.autoTrading = false;
  state.orders = [
    filledBuy({ id: "json-mode", code: "005930", qty: 1, price: 70_000, brokerOrderNo: "0000099999" }),
  ];
  await mirrorAfterJsonSave(state, paperEnv({ PERSISTENCE_MODE: "json" }), {
    brokerAccountId: ACTIVE_ID,
  });
  assert.equal(ledger.snapshot.orders.size, 0);
});
