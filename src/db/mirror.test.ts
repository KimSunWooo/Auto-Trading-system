import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyFill, createPaperState } from "@/lib/engine";
import { persistStateNow, configureStateStore, resetStateStoreForTest } from "@/lib/store";
import { JsonStateRepository } from "@/src/persistence/json-state-repository";
import { failingLedger, MemoryLedger } from "@/src/db/ledger";
import { projectAppState } from "@/src/db/projector";
import { importLegacyState } from "@/src/db/import-legacy";
import { mirrorAfterJsonSave, setMirrorLedgerForTest } from "@/src/db/mirror";
import { moneyNumber } from "@/src/db/money";
import { resetDatabaseStatusForTest, snapshotDatabaseStatus } from "@/src/db/status";
import { CASH_RULE_ID } from "@/src/rules/params";
import type { AppState, Order } from "@/lib/types";

const PREV_MODE = process.env.PERSISTENCE_MODE;
const PREV_URL = process.env.DATABASE_URL;

before(() => {
  process.env.PERSISTENCE_MODE = "json";
  delete process.env.DATABASE_URL;
  setMirrorLedgerForTest(null);
  resetDatabaseStatusForTest();
});

after(() => {
  if (PREV_MODE == null) delete process.env.PERSISTENCE_MODE;
  else process.env.PERSISTENCE_MODE = PREV_MODE;
  if (PREV_URL == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREV_URL;
  setMirrorLedgerForTest(null);
  resetStateStoreForTest();
  resetDatabaseStatusForTest();
});

function paperEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROKER: "kis",
    KIS_MODE: "paper",
    TRADING_MODE: "paper",
    // Mirror tests project ledger rows; accounts-owner keeps bootstrap non-ACTIVE.
    PAPER_RUNTIME_OWNER: "accounts",
    ...extra,
  };
}

function realEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROKER: "kis",
    KIS_MODE: "real",
    TRADING_MODE: "live",
    ALLOW_LIVE_TRADING: "false",
  };
}

function filledOrder(partial: Partial<Order> & Pick<Order, "id" | "code" | "side" | "qty" | "price">): Order {
  return {
    createdAt: "2026-09-16T00:00:00.000Z",
    source: "manual",
    name: partial.code,
    amount: partial.qty * partial.price,
    commission: 0,
    tax: 0,
    net: partial.qty * partial.price,
    status: "filled",
    ruleId: CASH_RULE_ID,
    orderedQty: partial.orderedQty ?? partial.qty,
    filledQty: partial.filledQty ?? partial.qty,
    ...partial,
  };
}

test("json mode does not write the ledger", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(failingLedger("should not run"));
  process.env.PERSISTENCE_MODE = "json";
  resetDatabaseStatusForTest();
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirae-json-"));
  const file = path.join(dir, "paper-account.json");
  try {
    const repo = new JsonStateRepository(file);
    const state = createPaperState();
    await repo.save(state);
    await mirrorAfterJsonSave(state, process.env);
    const counts = await ledger.transaction((tx) => tx.counts());
    assert.equal(counts.orders, 0);
    const status = snapshotDatabaseStatus({ enabled: false, mode: "json" });
    assert.equal(status.lastError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    setMirrorLedgerForTest(null);
  }
});

test("mirror writes JSON and ledger together", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  process.env.PERSISTENCE_MODE = "mirror";
  process.env.PAPER_RUNTIME_OWNER = "bootstrap";
  process.env.KIS_MODE = "paper";
  process.env.KIS_PAPER_ACCOUNT_NO = "11111111-01";
  process.env.KIS_PAPER_APP_KEY = "paper-key";
  process.env.KIS_PAPER_APP_SECRET = "paper-secret";
  process.env.BROKER_CREDENTIAL_MASTER_KEY = "test-broker-credential-master-key-32chars!!";
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirae-mirror-"));
  const file = path.join(dir, "paper-account.json");
  try {
    configureStateStore(file);
    const state = createPaperState();
    await persistStateNow(state);
    const loaded = JSON.parse(readFileSync(file, "utf8")) as AppState;
    assert.ok(loaded.settings);
    const counts = await ledger.transaction((tx) => tx.counts());
    assert.ok(counts.users >= 1);
    assert.ok(counts.brokerAccounts >= 1);
    assert.ok(counts.instruments >= 1);
  } finally {
    resetStateStoreForTest();
    setMirrorLedgerForTest(null);
    process.env.PERSISTENCE_MODE = "json";
    delete process.env.PAPER_RUNTIME_OWNER;
    delete process.env.KIS_PAPER_ACCOUNT_NO;
    delete process.env.KIS_PAPER_APP_KEY;
    delete process.env.KIS_PAPER_APP_SECRET;
    delete process.env.BROKER_CREDENTIAL_MASTER_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirror failure does not retry broker or corrupt JSON", async () => {
  let brokerSubmits = 0;
  setMirrorLedgerForTest(failingLedger("disk full"));
  process.env.PERSISTENCE_MODE = "mirror";
  resetDatabaseStatusForTest();
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirae-fail-"));
  const file = path.join(dir, "paper-account.json");
  try {
    const repo = new JsonStateRepository(file);
    const state = createPaperState();
    await repo.save(state);
    brokerSubmits += 0;
    await mirrorAfterJsonSave(state, process.env);
    const loaded = JSON.parse(readFileSync(file, "utf8")) as AppState;
    assert.equal(loaded.settings.disclaimerAccepted, true);
    assert.equal(brokerSubmits, 0);
    const status = snapshotDatabaseStatus({ enabled: true, mode: "mirror" });
    assert.match(status.lastError ?? "", /DB_MIRROR_DEGRADED/);
  } finally {
    setMirrorLedgerForTest(null);
    process.env.PERSISTENCE_MODE = "json";
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mirror mode reports connected without this process calling recordMirrorSuccess", () => {
  resetDatabaseStatusForTest();
  const mirror = snapshotDatabaseStatus({ enabled: true, mode: "mirror" });
  assert.equal(mirror.connected, true);
  const json = snapshotDatabaseStatus({ enabled: false, mode: "json" });
  assert.equal(json.connected, false);
});

test("duplicate intent projects to one DB row", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.intents = [
    {
      intentId: "sig:manual:cash:005930:buy:1:1",
      signalId: "sig:manual:cash:005930:buy:1:1",
      ruleId: CASH_RULE_ID,
      ticker: "005930",
      side: "buy",
      qty: 1,
      price: 74800,
      createdAt: "2026-09-16T00:00:00.000Z",
      reason: "manual",
      status: "submitted",
    },
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.intents, 1);
});

test("duplicate local_order_id projects to one order row", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({ id: "ord-local-1", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 74800 }),
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.orders, 1);
});

test("duplicate execution evidence inserts once", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({ id: "ord-exec-1", code: "005930", name: "삼성전자", side: "buy", qty: 2, price: 74800 }),
  ];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 2, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.executions, 1);
  const positions = await ledger.transaction(async (tx) =>
    tx.listPositions((await tx.listBrokerAccounts())[0]!.id),
  );
  assert.equal(positions.length, 1);
  assert.equal(moneyNumber(positions[0]!.quantity), 2);
});

test("partial fill: one parent order and two executions", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  const parent = filledOrder({
    id: "parent-100",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 100,
    orderedQty: 100,
    filledQty: 100,
    price: 70000,
    status: "filled",
  });
  const child1 = filledOrder({
    id: "child-40",
    parentOrderId: "parent-100",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 40,
    price: 70000,
  });
  const child2 = filledOrder({
    id: "child-60",
    parentOrderId: "parent-100",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 60,
    price: 70000,
  });
  state.orders = [parent, child1, child2];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 100, avgPrice: 70000, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.orders, 1);
  assert.equal(counts.executions, 2);
  const positions = await ledger.transaction(async (tx) =>
    tx.listPositions((await tx.listBrokerAccounts())[0]!.id),
  );
  assert.equal(moneyNumber(positions[0]!.quantity), 100);
});

test("buy history view/query is BUY executions only", async () => {
  const ledger = new MemoryLedger();
  let state = createPaperState();
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 2, price: 100 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 110 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 1, price: 120 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  const page = await ledger.transaction((tx) => tx.listBuyHistory({ limit: 50 }));
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((row) => row.symbol === "005930"));
});

test("trade cycle matches runtime weighted-average PnL and closes at 0", async () => {
  const ledger = new MemoryLedger();
  let state = createPaperState();
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 10, price: 100 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 5, price: 110 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 8, price: 120 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 7, price: 130 }).state;
  const runtimePnl = state.orders
    .filter((order) => order.side === "sell" && order.status === "filled")
    .reduce((sum, order) => sum + (order.realizedPnl ?? 0), 0);
  await projectAppState(ledger, state, { env: paperEnv() });
  const trades = await ledger.transaction((tx) => tx.listTrades({}));
  assert.equal(trades.items.length, 1);
  assert.equal(trades.items[0]!.status, "CLOSED");
  assert.equal(moneyNumber(trades.items[0]!.totalBuyQty), 15);
  assert.equal(moneyNumber(trades.items[0]!.totalSellQty), 15);
  assert.equal(moneyNumber(trades.items[0]!.realizedPnl), runtimePnl);
  const positions = await ledger.transaction((tx) => tx.listCurrentPositions({}));
  assert.equal(positions.items.length, 0);
});

test("PAPER and REAL positions are isolated by broker_account_id", async () => {
  const ledger = new MemoryLedger();
  const paper = createPaperState();
  paper.positions = [{ code: "AAPL", name: "Apple", qty: 1, avgPrice: 200, ruleId: CASH_RULE_ID }];
  const real = createPaperState();
  real.positions = [{ code: "AAPL", name: "Apple", qty: 9, avgPrice: 200, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, paper, { env: paperEnv() });
  await projectAppState(ledger, real, { env: realEnv() });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  assert.equal(accounts.length, 2);
  const envs = new Set(accounts.map((row) => row.environment));
  assert.ok(envs.has("PAPER"));
  assert.ok(envs.has("REAL"));
  const paperId = accounts.find((row) => row.environment === "PAPER")!.id;
  const realId = accounts.find((row) => row.environment === "REAL")!.id;
  const paperPos = await ledger.transaction((tx) => tx.listPositions(paperId));
  const realPos = await ledger.transaction((tx) => tx.listPositions(realId));
  assert.equal(moneyNumber(paperPos[0]!.quantity), 1);
  assert.equal(moneyNumber(realPos[0]!.quantity), 9);
});

test("domestic and overseas instruments keep country/currency separate", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 74800, ruleId: CASH_RULE_ID },
    { code: "AAPL", name: "Apple", qty: 1, avgPrice: 200, ruleId: CASH_RULE_ID },
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  const positions = await ledger.transaction(async (tx) => {
    const account = (await tx.listBrokerAccounts())[0]!;
    const rows = await tx.listPositions(account.id);
    return Promise.all(
      rows.map(async (row) => ({ row, instrument: await tx.getInstrument(row.instrumentId) })),
    );
  });
  const kr = positions.find((row) => row.instrument?.symbol === "005930");
  const us = positions.find((row) => row.instrument?.symbol === "AAPL");
  assert.equal(kr?.instrument?.country, "KR");
  assert.equal(kr?.instrument?.currency, "KRW");
  assert.equal(us?.instrument?.country, "US");
  assert.equal(us?.instrument?.currency, "USD");
  assert.notEqual(kr?.instrument?.id, us?.instrument?.id);
});

test("reconciliation mismatch is recorded without treating DB errors as recon", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.positions = [{ code: "005930", name: "삼성전자", qty: 2, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  state.kisBalance = {
    syncedAt: "2026-09-16T00:00:00.000Z",
    cash: 1_000_000,
    d2Cash: 1_000_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 74800 }],
    cashDelta: 0,
    matched: false,
    message: "Local Position = 2 / KIS Position = 1",
  };
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.reconRuns, 1);
  const run = await ledger.transaction(async (tx) => tx.lastReconRun((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(run?.status, "MISMATCH");
  assert.equal(state.circuit.halted, false);
});

test("cashBalance and orderableAmount are stored independently", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  await projectAppState(ledger, state, {
    env: paperEnv(),
    cash: [{ currency: "USD", cashBalance: 0, orderableAmount: 100000, source: "KIS_PSAMOUNT" }],
  });
  const snap = await ledger.transaction(async (tx) => tx.lastCashSnapshot((await tx.listBrokerAccounts())[0]!.id, "USD"));
  assert.equal(moneyNumber(snap!.cashBalance), 0);
  assert.equal(moneyNumber(snap!.orderableAmount), 100000);
  assert.notEqual(snap!.cashBalance, snap!.orderableAmount);
});

test("legacy import does not invent BUY executions from position-only state", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [];
  state.intents = [];
  state.positions = [{ code: "AAPL", name: "Apple", qty: 5, avgPrice: 200, ruleId: CASH_RULE_ID }];
  const result = await importLegacyState(ledger, { state, sourcePath: "data/paper-account.json", env: paperEnv() });
  const counts = await ledger.transaction((tx) => tx.counts());
  assert.equal(counts.executions, 0);
  assert.equal(counts.buyHistory, 0);
  const positions = await ledger.transaction((tx) => tx.listCurrentPositions({}));
  assert.equal(positions.items.length, 1);
  assert.equal(positions.items[0]!.provenance, "LEGACY_STATE");
  assert.equal(counts.migrationRuns, 1);
  assert.ok(result.warnings.some((row) => /LEGACY_STATE/.test(row)));
});

test("history pagination caps limit at 100", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = Array.from({ length: 3 }, (_, i) =>
    filledOrder({
      id: `buy-${i}`,
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70000 + i,
      createdAt: `2026-09-16T00:00:0${i}.000Z`,
    }),
  );
  await projectAppState(ledger, state, { env: paperEnv() });
  const page = await ledger.transaction((tx) => tx.listBuyHistory({ limit: 500 }));
  assert.equal(page.limit, 100);
  const small = await ledger.transaction((tx) => tx.listBuyHistory({ limit: 1 }));
  assert.equal(small.items.length, 1);
  assert.ok(small.nextCursor);
});

test("B. KRW orderable_amount maps from ord_psbl_cash not D+2", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.cash = 9_746_462;
  state.kisBalance = {
    syncedAt: "2026-09-17T04:00:00.000Z",
    fetchedAt: "2026-09-17T04:00:00.000Z",
    cash: 10_000_000,
    d2Cash: 8_888_888,
    orderableCash: 9_700_000,
    nrcvbBuyAmt: 9_690_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253500 }],
    cashDelta: -253_538,
    matched: true,
    freshness: "fresh",
    message: "PAPER deposit cash is not local ledger cash",
  };
  await projectAppState(ledger, state, { env: paperEnv() });
  const snap = await ledger.transaction(async (tx) =>
    tx.lastCashSnapshot((await tx.listBrokerAccounts())[0]!.id, "KRW"),
  );
  assert.equal(moneyNumber(snap!.cashBalance), 10_000_000);
  assert.equal(moneyNumber(snap!.orderableAmount), 9_700_000);
  assert.notEqual(moneyNumber(snap!.orderableAmount), 8_888_888);
  const account = await ledger.transaction(async (tx) =>
    tx.lastAccountSnapshot((await tx.listBrokerAccounts())[0]!.id),
  );
  assert.equal(moneyNumber(account!.cashValue), 9_746_462);
});

test("C. stale matched=true snapshot does not create a new HEALTHY recon run", async () => {
  const ledger = new MemoryLedger();
  const healthy = createPaperState();
  healthy.kisBalance = {
    syncedAt: "2026-09-17T03:00:00.000Z",
    fetchedAt: "2026-09-17T03:00:00.000Z",
    cash: 10_000_000,
    d2Cash: 10_000_000,
    orderableCash: 10_000_000,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: "fresh",
    message: "pre-order",
  };
  await projectAppState(ledger, healthy, { env: paperEnv() });
  const first = await ledger.transaction(async (tx) => tx.lastReconRun((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(first?.status, "HEALTHY");

  const afterFill = createPaperState();
  afterFill.cash = 9_746_462;
  afterFill.orders = [
    filledOrder({
      id: "post-fill",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      createdAt: "2026-09-17T03:20:00.000Z",
      brokerOrderNo: "0000022105",
    }),
  ];
  afterFill.kisBalance = { ...healthy.kisBalance! };
  await projectAppState(ledger, afterFill, { env: paperEnv() });
  const runs = ledger.snapshot.reconRuns;
  assert.ok(!runs.some((row) => row.status === "HEALTHY" && row.id !== first?.id));
  const last = await ledger.transaction(async (tx) => tx.lastReconRun((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(last?.status, "UNKNOWN");
});

test("E. FILLED order maps PENDING runtime intent to FILLED in DB", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.intents = [
    {
      intentId: "sig:vts:b2",
      signalId: "sig:vts:b2",
      ruleId: CASH_RULE_ID,
      ticker: "005930",
      side: "buy",
      qty: 1,
      price: 253500,
      createdAt: "2026-09-17T03:13:49.925Z",
      reason: "order-intent",
      status: "pending",
    },
  ];
  state.orders = [
    filledOrder({
      id: "filled-1",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      intentId: "sig:vts:b2",
      brokerOrderNo: "0000022105",
    }),
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  const intent = [...ledger.snapshot.intents.values()][0];
  const order = [...ledger.snapshot.orders.values()][0];
  assert.equal(order?.status, "FILLED");
  assert.equal(intent?.status, "FILLED");
});

test("same ODNO fill is not inserted twice with a new execution_key", async () => {
  const ledger = new MemoryLedger();
  const first = createPaperState();
  first.orders = [
    filledOrder({
      id: "orig",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      brokerOrderNo: "0000022105",
    }),
  ];
  await projectAppState(ledger, first, { env: paperEnv() });
  const recovered = createPaperState();
  recovered.orders = [
    filledOrder({
      id: "recovered-parent",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      brokerOrderNo: "0000022105",
    }),
  ];
  await projectAppState(ledger, recovered, { env: paperEnv() });
  assert.equal(ledger.snapshot.executions.size, 1);
  assert.equal(ledger.snapshot.orders.size, 1);
});
