/**
 * KisBroker pre-POST DB failures must not leave ghost pending → UNKNOWN_ACTIVE,
 * and process-global mirror lastError must not block a healthy account.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import { KisBroker } from "@/src/brokers/KisBroker";
import {
  assertDatabaseLedgerReadyForOrders,
  DatabaseLedgerError,
} from "@/src/db/persist";
import {
  recordMirrorDegraded,
  resetDatabaseStatusForTest,
  snapshotDatabaseStatus,
} from "@/src/db/status";
import { CASH_RULE_ID } from "@/src/rules/params";
import { isActiveUnknownBlocker } from "@/src/runtime/startup-sync";
import {
  releaseWorkerLock,
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";

function paperDbEnv() {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL = process.env.DATABASE_URL || "mysql://test:test@127.0.0.1:3306/test";
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
}

function withWorkerLock<T>(run: (lockPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kis-db-gate-"));
  const lockPath = path.join(dir, "worker.lock");
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("kis-db-gate", { filePath: lockPath }), true);
  return run(lockPath).finally(() => {
    releaseWorkerLock("kis-db-gate", { filePath: lockPath });
    resetWorkerLockForTest();
    rmSync(dir, { recursive: true, force: true });
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

function fakeClient(orderCashCalls: { n: number }) {
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
      if (opts?.beforeSubmit) await opts.beforeSubmit();
      orderCashCalls.n += 1;
      return { orderNo: "ODNO-OK-1", krxOrgNo: "x" };
    },
    async cancelOrder() {},
  };
}

test("pre-POST DatabaseLedgerError closes pending — no UNKNOWN_ACTIVE ghost", async () => {
  paperDbEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  resetDatabaseStatusForTest();
  await withWorkerLock(async (lockPath) => {
    try {
      const orderCashCalls = { n: 0 };
      const box = { current: createPaperState() };
      box.current.settings.autoTrading = true;
      box.current.settings.disclaimerAccepted = true;
      box.current.settings.ignoreMarketHours = true;
      seedLiveQuote(box.current);
      const broker = new KisBroker(
        box,
        fakeClient(orderCashCalls),
        CASH_RULE_ID,
        "rule",
        undefined,
        undefined,
        {
          persistState: async () => {
            throw new DatabaseLedgerError("db authority down");
          },
          safety: { workerLockPath: lockPath, startupSyncVerified: true },
        },
      );
      const fill = await broker.buyMarket("005930", 70_000);
      assert.equal(fill.ok, false);
      assert.match(fill.reason ?? "", /DB intent\/ledger 저장 실패|DB/);
      assert.equal(orderCashCalls.n, 0);
      const openish = box.current.orders.filter(
        (o) => !o.parentOrderId && (o.status === "pending" || o.status === "unknown"),
      );
      assert.equal(openish.length, 0, "no ghost pending/unknown after pre-POST fail");
      assert.ok(
        box.current.orders.every((o) => !isActiveUnknownBlocker(o)),
        "no UNKNOWN_ACTIVE blocker",
      );
      assert.ok(box.current.orders.some((o) => o.status === "rejected"));
    } finally {
      setNowMs(null);
      resetDatabaseStatusForTest();
    }
  });
});

test("stale global lastError does not block assertDatabaseLedgerReadyForOrders", () => {
  paperDbEnv();
  resetDatabaseStatusForTest();
  try {
    recordMirrorDegraded("account-A mirror fail");
    const status = snapshotDatabaseStatus({ enabled: true, mode: "database" });
    assert.ok(status.lastError);
    assert.equal(assertDatabaseLedgerReadyForOrders(), null);
  } finally {
    resetDatabaseStatusForTest();
  }
});

test("account B can order while account A persist fails (isolated)", async () => {
  paperDbEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  resetDatabaseStatusForTest();
  await withWorkerLock(async (lockPath) => {
    try {
      const callsA = { n: 0 };
      const callsB = { n: 0 };
      const boxA = { current: createPaperState() };
      const boxB = { current: createPaperState() };
      for (const box of [boxA, boxB]) {
        box.current.settings.autoTrading = true;
        box.current.settings.disclaimerAccepted = true;
        box.current.settings.ignoreMarketHours = true;
        seedLiveQuote(box.current);
      }
      const safety = { workerLockPath: lockPath, startupSyncVerified: true };
      const brokerA = new KisBroker(
        boxA,
        fakeClient(callsA),
        CASH_RULE_ID,
        "rule",
        undefined,
        undefined,
        {
          persistState: async () => {
            recordMirrorDegraded("account-A ledger fail");
            throw new DatabaseLedgerError("account-A ledger fail");
          },
          safety,
        },
      );
      const brokerB = new KisBroker(
        boxB,
        fakeClient(callsB),
        CASH_RULE_ID,
        "rule",
        undefined,
        undefined,
        {
          persistState: async () => {
            /* healthy */
          },
          safety,
        },
      );
      const fillA = await brokerA.buyMarket("005930", 70_000);
      assert.equal(fillA.ok, false);
      assert.equal(callsA.n, 0);

      await brokerB.buyMarket("005930", 70_000);
      assert.equal(callsB.n, 1, "healthy account B must reach KIS orderCash once");
    } finally {
      setNowMs(null);
      resetDatabaseStatusForTest();
    }
  });
});
