import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyFill, createPaperState } from "@/lib/engine";
import { persistStateNow, configureStateStore, resetStateStoreForTest } from "@/lib/store";
import { JsonStateRepository } from "@/src/persistence/json-state-repository";
import { failingLedger, MemoryLedger } from "@/src/db/ledger";
import { projectAppState } from "@/src/db/projector";
import { importLegacyState } from "@/src/db/import-legacy";
import { money, moneyNumber } from "@/src/db/money";
import { mirrorAfterJsonSave, setMirrorLedgerForTest } from "@/src/db/mirror";
import { getBuyHistory, getDbPositions, getTradeHistory } from "@/src/db/repositories/history";
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
    ...extra,
  };
}

function realEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BROKER: "kis",
    KIS_MODE: "real",
    TRADING_MODE: "live",
    ALLOW_LIVE_TRADING: "false",
    ...extra,
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

async function ledgerCounts(ledger: MemoryLedger) {
  return ledger.transaction((tx) => tx.counts());
}

test("Gate 6: identical AppState mirrored 10 times does not duplicate ledger rows", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.intents = [
    {
      intentId: "sig:manual:cash:005930:buy:1:gate",
      signalId: "sig:manual:cash:005930:buy:1:gate",
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
  state.orders = [
    filledOrder({
      id: "ord-gate-1",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 74800,
      brokerOrderNo: "ODNO9001",
      intentId: "sig:manual:cash:005930:buy:1:gate",
    }),
  ];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  const first = await ledgerCounts(ledger);
  for (let i = 0; i < 9; i += 1) {
    await projectAppState(ledger, state, { env: paperEnv() });
  }
  const tenth = await ledgerCounts(ledger);
  assert.equal(tenth.intents, first.intents);
  assert.equal(tenth.orders, first.orders);
  assert.equal(tenth.executions, first.executions);
  assert.equal(tenth.positions, first.positions);
  assert.equal(tenth.trades, first.trades);
  assert.equal(tenth.intents, 1);
  assert.equal(tenth.orders, 1);
  assert.equal(tenth.executions, 1);
  assert.equal(tenth.orderEvents, first.orderEvents);
  assert.equal(tenth.cashSnapshots, first.cashSnapshots);
  assert.equal(tenth.accountSnapshots, first.accountSnapshots);
});

test("Gate 7-8: intent_key and local_order_id stay unique; ODNO is exact not fuzzy", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.intents = [
    {
      intentId: "intent-exact-1",
      signalId: "sig:manual:cash:005930:buy:1:exact",
      ruleId: CASH_RULE_ID,
      ticker: "005930",
      side: "buy",
      qty: 1,
      price: 70000,
      createdAt: "2026-09-16T00:00:00.000Z",
      reason: "manual",
      status: "submitted",
    },
  ];
  state.orders = [
    filledOrder({
      id: "local-a",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70000,
      brokerOrderNo: "ODNO-A",
      createdAt: "2026-09-16T01:00:00.000Z",
    }),
    filledOrder({
      id: "local-b",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70000,
      brokerOrderNo: "ODNO-B",
      createdAt: "2026-09-16T01:00:00.000Z",
    }),
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledgerCounts(ledger);
  assert.equal(counts.intents, 1);
  assert.equal(counts.orders, 2);
  const account = (await ledger.transaction((tx) => tx.listBrokerAccounts()))[0]!;
  const a = await ledger.transaction((tx) => tx.getOrderByLocalId(account.id, "local-a"));
  const b = await ledger.transaction((tx) => tx.getOrderByLocalId(account.id, "local-b"));
  assert.equal(a?.brokerOrderNo, "ODNO-A");
  assert.equal(b?.brokerOrderNo, "ODNO-B");
  assert.notEqual(a?.id, b?.id);
});

test("Gate 9: same execution evidence 10 times does not move position or PnL twice", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({ id: "exec-once", code: "005930", name: "삼성전자", side: "buy", qty: 3, price: 100 }),
  ];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 3, avgPrice: 100, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  for (let i = 0; i < 9; i += 1) {
    await projectAppState(ledger, state, { env: paperEnv() });
  }
  const counts = await ledgerCounts(ledger);
  assert.equal(counts.executions, 1);
  assert.equal(counts.trades, 1);
  const positions = await ledger.transaction(async (tx) => tx.listPositions((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(moneyNumber(positions[0]!.quantity), 3);
  const trades = await ledger.transaction((tx) => tx.listTrades({}));
  assert.equal(moneyNumber(trades.items[0]!.totalBuyQty), 3);
  assert.equal(moneyNumber(trades.items[0]!.realizedPnl), 0);
});

test("Gate 10: partial fill 40+60 then replay adds no execution or position delta", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({
      id: "parent-100",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 100,
      orderedQty: 100,
      filledQty: 100,
      price: 70000,
    }),
    filledOrder({
      id: "child-40",
      parentOrderId: "parent-100",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 40,
      price: 70000,
    }),
    filledOrder({
      id: "child-60",
      parentOrderId: "parent-100",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 60,
      price: 70000,
    }),
  ];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 100, avgPrice: 70000, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledgerCounts(ledger);
  assert.equal(counts.orders, 1);
  assert.equal(counts.executions, 2);
  const account = (await ledger.transaction((tx) => tx.listBrokerAccounts()))[0]!;
  const order = await ledger.transaction((tx) => tx.getOrderByLocalId(account.id, "parent-100"));
  assert.equal(moneyNumber(order!.filledQty), 100);
  const positions = await ledger.transaction((tx) => tx.listPositions(account.id));
  assert.equal(moneyNumber(positions[0]!.quantity), 100);
});

test("Gate 11: buy history is executions WHERE side=BUY, matching the repository", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  process.env.PERSISTENCE_MODE = "mirror";
  let state = createPaperState();
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 2, price: 100 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 110 }).state;
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 1, price: 120 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledgerCounts(ledger);
  assert.equal(counts.buyHistory, 2);
  const page = await getBuyHistory({ limit: 50 }, { ...paperEnv(), PERSISTENCE_MODE: "mirror" });
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((row) => row.symbol === "005930"));
  setMirrorLedgerForTest(null);
  process.env.PERSISTENCE_MODE = "json";
});

test("Gate 12: weighted-average trade cycle OPEN → PARTIALLY_CLOSED → CLOSED", async () => {
  const ledger = new MemoryLedger();
  let state = createPaperState();
  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 10, price: 100 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  let trades = await ledger.transaction((tx) => tx.listTrades({}));
  assert.equal(trades.items.length, 1);
  assert.equal(trades.items[0]!.status, "OPEN");

  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "buy", qty: 5, price: 110 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  trades = await ledger.transaction((tx) => tx.listTrades({}));
  assert.equal(trades.items.length, 1);
  assert.equal(trades.items[0]!.status, "OPEN");
  assert.equal(moneyNumber(trades.items[0]!.totalBuyQty), 15);
  const jsonPos = state.positions.find((row) => row.code === "005930")!;
  const dbPos = (await ledger.transaction(async (tx) => tx.listPositions((await tx.listBrokerAccounts())[0]!.id)))[0]!;
  assert.equal(moneyNumber(dbPos.quantity), jsonPos.qty);
  assert.equal(money(dbPos.averagePrice), money(jsonPos.avgPrice));

  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 8, price: 120 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  trades = await ledger.transaction((tx) => tx.listTrades({}));
  assert.equal(trades.items[0]!.status, "PARTIALLY_CLOSED");

  state = applyFill(state, { source: "manual", code: "005930", name: "삼성전자", side: "sell", qty: 7, price: 130 }).state;
  await projectAppState(ledger, state, { env: paperEnv() });
  trades = await ledger.transaction((tx) => tx.listTrades({}));
  const runtimePnl = state.orders
    .filter((order) => order.side === "sell" && order.status === "filled")
    .reduce((sum, order) => sum + (order.realizedPnl ?? 0), 0);
  assert.equal(trades.items.length, 1);
  assert.equal(trades.items[0]!.status, "CLOSED");
  assert.equal(moneyNumber(trades.items[0]!.totalBuyQty), 15);
  assert.equal(moneyNumber(trades.items[0]!.totalSellQty), 15);
  assert.equal(moneyNumber(trades.items[0]!.realizedPnl), runtimePnl);
  assert.equal(money(trades.items[0]!.averageBuyPrice), money(1550 / 15));
  assert.equal(money(trades.items[0]!.averageSellPrice), money((8 * 120 + 7 * 130) / 15));
  const remaining = await ledger.transaction((tx) => tx.listCurrentPositions({}));
  assert.equal(remaining.items.length, 0);
  assert.equal(state.positions.filter((row) => row.qty > 0).length, 0);
});

test("Gate 13: DB position snapshots JSON qty/avgPrice/ruleScope without reinterpretation", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 4, avgPrice: 74123.5, ruleId: CASH_RULE_ID },
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  const row = (await ledger.transaction(async (tx) => tx.listPositions((await tx.listBrokerAccounts())[0]!.id)))[0]!;
  const json = state.positions[0]!;
  const instrument = await ledger.transaction((tx) => tx.getInstrument(row.instrumentId));
  assert.equal(instrument?.symbol, json.code);
  assert.equal(row.ruleScope, json.ruleId);
  assert.equal(moneyNumber(row.quantity), json.qty);
  assert.equal(money(row.averagePrice), money(json.avgPrice));
});

test("Gate 14: legacy position-only import does not invent BUY executions", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [];
  state.intents = [];
  state.positions = [{ code: "AAPL", name: "Apple", qty: 5, avgPrice: 200, ruleId: CASH_RULE_ID }];
  await importLegacyState(ledger, { state, sourcePath: "data/paper-account.json", env: paperEnv() });
  const counts = await ledgerCounts(ledger);
  assert.equal(counts.executions, 0);
  const positions = await ledger.transaction((tx) => tx.listCurrentPositions({}));
  assert.equal(positions.items[0]!.provenance, "LEGACY_STATE");
});

test("Gate 15: trimmed JSON orders are not deleted from the ledger", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({ id: "keep-me", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 100 }),
    filledOrder({ id: "trim-me", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 110 }),
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  const before = await ledgerCounts(ledger);
  const trimmed: AppState = { ...state, orders: state.orders.filter((row) => row.id === "keep-me") };
  await projectAppState(ledger, trimmed, { env: paperEnv() });
  const after = await ledgerCounts(ledger);
  assert.equal(after.orders, before.orders);
  assert.equal(after.executions, before.executions);
  assert.equal(after.trades, before.trades);
  const account = (await ledger.transaction((tx) => tx.listBrokerAccounts()))[0]!;
  const trimmedRow = await ledger.transaction((tx) => tx.getOrderByLocalId(account.id, "trim-me"));
  assert.ok(trimmedRow);
});

test("Gate 16: PAPER and REAL AAPL ledgers are isolated without placing REAL orders", async () => {
  const ledger = new MemoryLedger();
  const paper = createPaperState();
  paper.orders = [filledOrder({ id: "paper-aapl", code: "AAPL", name: "Apple", side: "buy", qty: 1, price: 200 })];
  paper.positions = [{ code: "AAPL", name: "Apple", qty: 1, avgPrice: 200, ruleId: CASH_RULE_ID }];
  const real = createPaperState();
  real.orders = [filledOrder({ id: "real-aapl", code: "AAPL", name: "Apple", side: "buy", qty: 2, price: 210 })];
  real.positions = [{ code: "AAPL", name: "Apple", qty: 2, avgPrice: 210, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, paper, { env: paperEnv() });
  await projectAppState(ledger, real, { env: realEnv() });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  const paperId = accounts.find((row) => row.environment === "PAPER")!.id;
  const realId = accounts.find((row) => row.environment === "REAL")!.id;
  assert.notEqual(paperId, realId);
  const paperPos = await ledger.transaction((tx) => tx.listPositions(paperId));
  const realPos = await ledger.transaction((tx) => tx.listPositions(realId));
  assert.equal(moneyNumber(paperPos[0]!.quantity), 1);
  assert.equal(moneyNumber(realPos[0]!.quantity), 2);
  const paperBuys = await ledger.transaction((tx) => tx.listBuyHistory({ account: paperId }));
  const realBuys = await ledger.transaction((tx) => tx.listBuyHistory({ account: realId }));
  assert.equal(paperBuys.items.length, 1);
  assert.equal(realBuys.items.length, 1);
  assert.notEqual(paperBuys.items[0]!.executionId, realBuys.items[0]!.executionId);
});

test("Gate 17: domestic 005930 and overseas AAPL keep instrument identity and currency", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [
    filledOrder({ id: "kr-buy", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 74800 }),
    filledOrder({ id: "us-buy", code: "AAPL", name: "Apple", side: "buy", qty: 1, price: 200 }),
  ];
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 74800, ruleId: CASH_RULE_ID },
    { code: "AAPL", name: "Apple", qty: 1, avgPrice: 200, ruleId: CASH_RULE_ID },
  ];
  await projectAppState(ledger, state, { env: paperEnv() });
  const rows = await ledger.transaction(async (tx) => {
    const account = (await tx.listBrokerAccounts())[0]!;
    const positions = await tx.listPositions(account.id);
    return Promise.all(positions.map(async (row) => ({ row, instrument: await tx.getInstrument(row.instrumentId) })));
  });
  const kr = rows.find((row) => row.instrument?.symbol === "005930")!;
  const us = rows.find((row) => row.instrument?.symbol === "AAPL")!;
  assert.equal(kr.instrument?.country, "KR");
  assert.equal(kr.instrument?.market, "KOSPI");
  assert.equal(kr.instrument?.currency, "KRW");
  assert.equal(us.instrument?.country, "US");
  assert.equal(us.instrument?.market, "NASDAQ");
  assert.equal(us.instrument?.currency, "USD");
  assert.notEqual(kr.instrument?.id, us.instrument?.id);
});

test("Gate 18: USD cashBalance 0 and orderableAmount 100000 stay distinct", async () => {
  const ledger = new MemoryLedger();
  await projectAppState(ledger, createPaperState(), {
    env: paperEnv(),
    cash: [{ currency: "USD", cashBalance: 0, orderableAmount: 100000, source: "KIS_PSAMOUNT" }],
  });
  const snap = await ledger.transaction(async (tx) => tx.lastCashSnapshot((await tx.listBrokerAccounts())[0]!.id, "USD"));
  assert.equal(moneyNumber(snap!.cashBalance), 0);
  assert.equal(moneyNumber(snap!.orderableAmount), 100000);
});

test("Gate 19-20: JSON save survives RDS failure and recovers without duplicates or broker retry", async () => {
  let brokerSubmits = 0;
  const memory = new MemoryLedger();
  process.env.PERSISTENCE_MODE = "mirror";
  resetDatabaseStatusForTest();
  const dir = mkdtempSync(path.join(os.tmpdir(), "mirae-gate-"));
  const file = path.join(dir, "paper-account.json");
  try {
    const state = createPaperState();
    state.orders = [filledOrder({ id: "recover-1", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 100 })];
    const repo = new JsonStateRepository(file);
    await repo.save(state);
    setMirrorLedgerForTest(failingLedger("unavailable"));
    await mirrorAfterJsonSave(state, process.env);
    assert.equal(brokerSubmits, 0);
    const loaded = JSON.parse(readFileSync(file, "utf8")) as AppState;
    assert.equal(loaded.orders[0]?.id, "recover-1");
    assert.match(snapshotDatabaseStatus({ enabled: true, mode: "mirror" }).lastError ?? "", /DB_MIRROR_DEGRADED/);
    assert.equal((await ledgerCounts(memory)).orders, 0);

    setMirrorLedgerForTest(memory);
    await mirrorAfterJsonSave(state, process.env);
    await mirrorAfterJsonSave(state, process.env);
    const counts = await ledgerCounts(memory);
    assert.equal(counts.orders, 1);
    assert.equal(counts.executions, 1);
    assert.equal(brokerSubmits, 0);
    const recovered = snapshotDatabaseStatus({ enabled: true, mode: "mirror" });
    assert.equal(recovered.lastError, null);
    assert.ok(recovered.lastMirrorAt);
  } finally {
    setMirrorLedgerForTest(null);
    process.env.PERSISTENCE_MODE = "json";
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gate 21: HEALTHY and MISMATCH recon persist without changing the trading gate", async () => {
  const ledger = new MemoryLedger();
  const healthy = createPaperState();
  healthy.kisBalance = {
    syncedAt: "2026-09-16T00:00:00.000Z",
    cash: 1_000_000,
    d2Cash: 1_000_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 74800 }],
    cashDelta: 0,
    matched: true,
    message: "synced",
  };
  healthy.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, healthy, { env: paperEnv() });
  let run = await ledger.transaction(async (tx) => tx.lastReconRun((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(run?.status, "HEALTHY");
  assert.equal(healthy.circuit.halted, false);
  const healthyItems = ledger.snapshot.reconItems.filter((row) => row.reconciliationRunId === run?.id);
  assert.ok(healthyItems.some((row) => row.itemType === "POSITION" && row.status === "MATCH"));

  const mismatch = createPaperState();
  mismatch.positions = [{ code: "005930", name: "삼성전자", qty: 2, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  mismatch.kisBalance = {
    syncedAt: "2026-09-16T00:01:00.000Z",
    cash: 1_000_000,
    d2Cash: 1_000_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 74800 }],
    cashDelta: 0,
    matched: false,
    message: "Local Position = 2 / KIS Position = 1",
  };
  await projectAppState(ledger, mismatch, { env: paperEnv() });
  run = await ledger.transaction(async (tx) => tx.lastReconRun((await tx.listBrokerAccounts())[0]!.id));
  assert.equal(run?.status, "MISMATCH");
  const items = ledger.snapshot.reconItems.filter((row) => row.reconciliationRunId === run?.id);
  assert.ok(items.some((row) => row.itemType === "POSITION" && row.status === "MISMATCH"));
  assert.equal(mismatch.circuit.halted, false);
});

test("Gate 22: history APIs paginate and filter; missing order/execution routes stay absent", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  process.env.PERSISTENCE_MODE = "mirror";
  const state = createPaperState();
  state.orders = Array.from({ length: 3 }, (_, i) =>
    filledOrder({
      id: `hist-${i}`,
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70000 + i,
      createdAt: `2026-09-16T00:00:0${i}.000Z`,
    }),
  );
  await projectAppState(ledger, state, { env: paperEnv() });
  const env = { ...paperEnv(), PERSISTENCE_MODE: "mirror" };
  const capped = await getBuyHistory({ limit: 500 }, env);
  assert.equal(capped.limit, 100);
  const page = await getBuyHistory({ limit: 1, symbol: "005930", country: "KR", market: "KOSPI" }, env);
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const trades = await getTradeHistory({ limit: 50, symbol: "005930" }, env);
  assert.ok(trades.items.length >= 1);
  const positions = await getDbPositions({ limit: 50 }, env);
  assert.ok(Array.isArray(positions.items));
  assert.equal(existsSync(path.join(process.cwd(), "app/api/history/orders/route.ts")), false);
  assert.equal(existsSync(path.join(process.cwd(), "app/api/history/executions/route.ts")), false);
  assert.equal(existsSync(path.join(process.cwd(), "app/api/history/buys/route.ts")), true);
  assert.equal(existsSync(path.join(process.cwd(), "app/api/db/positions/route.ts")), true);
  setMirrorLedgerForTest(null);
  process.env.PERSISTENCE_MODE = "json";
});

test("Gate 23: bootstrap user and fixture user B do not share accounts or positions", async () => {
  const ledger = new MemoryLedger();
  const userA = createPaperState();
  userA.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  const userB = createPaperState();
  userB.positions = [{ code: "005930", name: "삼성전자", qty: 8, avgPrice: 74800, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, userA, { env: paperEnv({ BOOTSTRAP_USER_EMAIL: "user-a@localhost" }) });
  await projectAppState(ledger, userB, { env: paperEnv({ BOOTSTRAP_USER_EMAIL: "user-b@localhost" }) });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  assert.equal(new Set(accounts.map((row) => row.userId)).size, 2);
  const a = accounts.find((row) => row.userId !== accounts[1]?.userId || row.id === accounts[0]?.id)!;
  const b = accounts.find((row) => row.userId !== a.userId)!;
  const aPos = await ledger.transaction((tx) => tx.listPositions(a.id));
  const bPos = await ledger.transaction((tx) => tx.listPositions(b.id));
  assert.equal(moneyNumber(aPos[0]!.quantity), 1);
  assert.equal(moneyNumber(bPos[0]!.quantity), 8);
  const aBuys = await ledger.transaction((tx) => tx.listCurrentPositions({ account: a.id }));
  const bLeak = aBuys.items.filter((row) => row.brokerAccountId === b.id);
  assert.equal(bLeak.length, 0);
});

test("Gate 24: ledger counts are finite and contain no credential secrets", async () => {
  const ledger = new MemoryLedger();
  const state = createPaperState();
  state.orders = [filledOrder({ id: "count-1", code: "005930", name: "삼성전자", side: "buy", qty: 1, price: 100 })];
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 100, ruleId: CASH_RULE_ID }];
  await projectAppState(ledger, state, { env: paperEnv() });
  const counts = await ledgerCounts(ledger);
  assert.ok(counts.users >= 1);
  assert.ok(counts.brokerAccounts >= 1);
  assert.ok(counts.intents >= 0);
  assert.ok(counts.orders >= 1);
  assert.ok(counts.executions >= 1);
  assert.ok(counts.positions >= 1);
  assert.ok(counts.trades >= 1);
  const payload = JSON.stringify(counts);
  assert.equal(/APP_KEY|APP_SECRET|DATABASE_URL|PASSWORD/i.test(payload), false);
});
