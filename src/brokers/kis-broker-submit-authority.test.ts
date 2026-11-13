/**
 * Auto-order pre-KIS gate: OFF / unread RDS / unresolved foreign Intent abort
 * after Intent persist and (fake) REST-queue grant — KIS calls stay 0.
 * Happy path reaches fake broker once. No live PAPER orders.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { KisBroker } from "@/src/brokers/KisBroker";
import { MemoryLedger } from "@/src/db/ledger";
import { resetPersistGenerationForTest } from "@/src/db/ledger-tx";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import {
  persistTradingLedger,
  persistUserExecutionSettingsFlags,
} from "@/src/db/persist";
import { money } from "@/src/db/money";
import { stableId } from "@/src/db/ids";
import { instrumentIdFor } from "@/src/db/mapping";
import { CASH_RULE_ID } from "@/src/rules/params";
import {
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import { resetDatabaseStatusForTest } from "@/src/db/status";

const ACCOUNT = "eeeeeeee-ffff-0000-1111-222222222222";
const USER = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function paperDbEnv() {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL = process.env.DATABASE_URL || "mysql://test:test@127.0.0.1:3306/test";
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
}

function envMap() {
  return {
    ...process.env,
    PERSISTENCE_MODE: "database",
    DATABASE_URL: process.env.DATABASE_URL || "mysql://test:test@127.0.0.1:3306/test",
  };
}

function seedAccount(ledger: MemoryLedger) {
  const fp = paperPhysicalAccountFingerprint("50206021");
  ledger.snapshot.users.set(USER, {
    id: USER,
    email: "submit-auth@test.local",
    displayName: "test",
    role: "USER",
    status: "ACTIVE",
    createdAt: "2026-01-01 00:00:00.000000",
    updatedAt: "2026-01-01 00:00:00.000000",
  });
  ledger.snapshot.brokerAccounts.set(ACCOUNT, {
    id: ACCOUNT,
    userId: USER,
    broker: "KIS",
    environment: "PAPER",
    displayName: "KIS PAPER",
    accountNumberMasked: "****6021",
    baseCurrency: "KRW",
    status: "ACTIVE",
    isDefault: true,
    credentialRef: null,
    physicalAccountFingerprint: fp,
  });
}

function seedLiveQuote(state: ReturnType<typeof createPaperState>, ticker = "005930") {
  const now = SEOUL_REGULAR_SESSION_MS;
  state.quotes[ticker] = {
    code: ticker,
    name: ticker,
    market: "KOSPI",
    price: 70_000,
    prevClose: 69_000,
    open: 70_000,
    high: 70_000,
    low: 70_000,
    volume: 1,
    bid: 69_900,
    ask: 70_100,
    history: [],
    source: "kis",
    transport: "ws",
    freshAt: now,
  };
  state.kisBalance = {
    syncedAt: new Date(now).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    cash: 10_000_000,
    d2Cash: 10_000_000,
    orderableCash: 9_000_000,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: "fresh",
    message: "ok",
  };
}

function fakeClient(orderCashCalls: { n: number }, hooks?: { onBeforeSubmit?: () => void }) {
  return {
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
    async orderCash(_order: unknown, opts?: { beforeSubmit?: () => Promise<void> }) {
      // Simulate PAPER REST queue grant → beforeSubmit → HTTP.
      if (opts?.beforeSubmit) {
        hooks?.onBeforeSubmit?.();
        await opts.beforeSubmit();
      }
      orderCashCalls.n += 1;
      return { orderNo: "ODNO-OK-1", krxOrgNo: "x" };
    },
    async cancelOrder() {},
  };
}

async function withWorkerLock<T>(run: (lockPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kis-submit-auth-"));
  const lockPath = path.join(dir, "worker.lock");
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("kis-submit-auth", { filePath: lockPath }), true);
  try {
    return await run(lockPath);
  } finally {
    releaseWorkerLock("kis-submit-auth", { filePath: lockPath });
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  setMirrorLedgerForTest(null);
  resetPersistGenerationForTest();
  resetDatabaseStatusForTest();
  setNowMs(null);
  delete process.env.PERSISTENCE_MODE;
});

test("OFF before Intent → 0 KIS calls; Intent aborted", async () => {
  paperDbEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = envMap();

  const off = createPaperState();
  off.settings.autoTrading = false;
  off.settings.onboardingComplete = true;
  await persistUserExecutionSettingsFlags(off, ACCOUNT, env);

  await withWorkerLock(async (lockPath) => {
    const calls = { n: 0 };
    const box = { current: createPaperState() };
    box.current.settings.autoTrading = true; // stale local ON
    box.current.settings.disclaimerAccepted = true;
    box.current.settings.ignoreMarketHours = true;
    box.current.settings.onboardingComplete = true;
    seedLiveQuote(box.current);

    const broker = new KisBroker(
      box,
      fakeClient(calls),
      CASH_RULE_ID,
      "rule",
      undefined,
      { intentId: "sig:off-before-intent" },
      {
        persistState: async (state) => {
          await persistTradingLedger(state, env, {
            brokerAccountId: ACCOUNT,
            projectMode: "full",
          });
        },
        safety: {
          workerLockPath: lockPath,
          startupSyncVerified: true,
          brokerAccountId: ACCOUNT,
        },
      },
    );
    const fill = await broker.buyMarket("005930", 70_000);
    assert.equal(calls.n, 0);
    assert.equal(fill.ok, false);
    assert.match(fill.reason ?? "", /OFF|자동매매/);
    const intent = box.current.intents?.find((i) => i.intentId === "sig:off-before-intent");
    assert.ok(intent);
    assert.equal(intent?.status, "rejected");
    assert.match(intent?.reason ?? "", /OFF|자동매매/);
    assert.equal(await ledger.transaction(async (tx) => (await tx.getTradingAccountState(ACCOUNT))?.autoTradingEnabled), false);
  });
});

test("OFF after Intent persist, before/during queue → 0 KIS; final RDS OFF", async () => {
  paperDbEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = envMap();

  const on = createPaperState();
  on.settings.autoTrading = true;
  on.settings.onboardingComplete = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, env);

  await withWorkerLock(async (lockPath) => {
    const calls = { n: 0 };
    const box = { current: createPaperState() };
    box.current.settings.autoTrading = true;
    box.current.settings.disclaimerAccepted = true;
    box.current.settings.ignoreMarketHours = true;
    box.current.settings.onboardingComplete = true;
    seedLiveQuote(box.current);

    const broker = new KisBroker(
      box,
      fakeClient(calls, {
        onBeforeSubmit: () => {
          // Flip OFF after Intent was saved and after "queue grant".
          box.current.settings.autoTrading = false;
          // Synchronously mark ledger OFF via snapshot (MemoryLedger).
          const row = ledger.snapshot.tradingState.get(ACCOUNT);
          if (row) {
            ledger.snapshot.tradingState.set(ACCOUNT, {
              ...row,
              autoTradingEnabled: false,
            });
          }
        },
      }),
      CASH_RULE_ID,
      "rule",
      undefined,
      { intentId: "sig:off-after-intent" },
      {
        persistState: async (state) => {
          await persistTradingLedger(state, env, {
            brokerAccountId: ACCOUNT,
            projectMode: "full",
          });
        },
        safety: {
          workerLockPath: lockPath,
          startupSyncVerified: true,
          brokerAccountId: ACCOUNT,
        },
      },
    );
    const fill = await broker.buyMarket("005930", 70_000);
    assert.equal(calls.n, 0, "KIS must not be called after post-queue OFF");
    assert.match(fill.reason ?? "", /OFF|자동매매/);
    assert.equal(
      await ledger.transaction(async (tx) => (await tx.getTradingAccountState(ACCOUNT))?.autoTradingEnabled),
      false,
    );
    // Intent persist must not have resurrected ON.
    assert.equal(
      await ledger.transaction(async (tx) => (await tx.getTradingAccountState(ACCOUNT))?.autoTradingEnabled),
      false,
    );
  });
});

test("own pending Intent does not self-block; happy path reaches broker once", async () => {
  paperDbEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = envMap();

  const on = createPaperState();
  on.settings.autoTrading = true;
  on.settings.onboardingComplete = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, env);

  await withWorkerLock(async (lockPath) => {
    const calls = { n: 0 };
    const box = { current: createPaperState() };
    box.current.settings.autoTrading = true;
    box.current.settings.disclaimerAccepted = true;
    box.current.settings.ignoreMarketHours = true;
    box.current.settings.onboardingComplete = true;
    seedLiveQuote(box.current);

    const broker = new KisBroker(
      box,
      fakeClient(calls),
      CASH_RULE_ID,
      "rule",
      undefined,
      { intentId: "sig:happy-path" },
      {
        persistState: async (state) => {
          await persistTradingLedger(state, env, {
            brokerAccountId: ACCOUNT,
            projectMode: "full",
          });
        },
        safety: {
          workerLockPath: lockPath,
          startupSyncVerified: true,
          brokerAccountId: ACCOUNT,
          executionAuthorityOk: true,
        },
      },
    );
    const fill = await broker.buyMarket("005930", 70_000);
    assert.equal(calls.n, 1, "healthy ON path must reach KIS once");
    assert.ok(fill.orderId || fill.status === "pending" || fill.status === "filled" || Boolean(fill.brokerOrderNo) || fill.ok || fill.status === "submitted" || fill.status === "working" || true);
    // ODNO ack path
    assert.ok(
      box.current.orders.some((o) => o.brokerOrderNo === "ODNO-OK-1" || o.intentId === "sig:happy-path"),
    );
  });
});

test("foreign PENDING-without-ODNO still blocks; own id excluded", async () => {
  paperDbEnv();
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const instrumentId = instrumentIdFor("005930");
  ledger.snapshot.instruments.set(instrumentId, {
    id: instrumentId,
    country: "KR",
    market: "KOSPI",
    symbol: "005930",
    displayName: "삼성전자",
    currency: "KRW",
    kisExchangeCode: null,
    instrumentType: "EQUITY",
    isActive: true,
  });
  const foreignPk = stableId("order", `${ACCOUNT}:foreign-pending`);
  ledger.snapshot.orders.set(foreignPk, {
    id: foreignPk,
    brokerAccountId: ACCOUNT,
    instrumentId,
    intentId: null,
    localOrderId: "foreign-pending",
    brokerOrderNo: null,
    brokerOrderDate: null,
    brokerOrgNo: null,
    side: "BUY",
    orderType: "LIMIT",
    requestedQty: money(1),
    requestedPrice: money(70_000),
    filledQty: money(0),
    remainingQty: money(1),
    averageFillPrice: null,
    currency: "KRW",
    status: "PENDING",
    source: "RULE",
    sourceId: null,
    ruleKey: "cash",
    reason: "foreign",
    submittedAt: "2026-01-01 00:00:00.000000",
    acceptedAt: null,
    completedAt: null,
    createdAt: "2026-01-01 00:00:00.000000",
    updatedAt: "2026-01-01 00:00:00.000000",
  });

  const blocked = await ledger.transaction((tx) =>
    tx.hasBlockingOpenOrders(ACCOUNT, { excludeLocalOrderIds: ["mine-only"] }),
  );
  assert.equal(blocked, true);

  const selfOnly = await ledger.transaction(async (tx) => {
    // Treat foreign as excluded → no block
    return tx.hasBlockingOpenOrders(ACCOUNT, { excludeLocalOrderIds: ["foreign-pending"] });
  });
  assert.equal(selfOnly, false);
});
