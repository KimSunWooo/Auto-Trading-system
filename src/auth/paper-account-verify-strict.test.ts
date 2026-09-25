/**
 * SV1–SV9 strict readyForTrading gates (unit, no live KIS orders).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { verifyPaperAccountForUser } from "@/src/auth/paper-account-verify";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";
import { resetDbClientForTest } from "@/src/db/client";
import type { AppState } from "@/lib/types";
import type { RuntimeScope } from "@/src/runtime/runtime-scope";

const PREV_URL = process.env.DATABASE_URL;
const PREV_MASTER = process.env.BROKER_CREDENTIAL_MASTER_KEY;
const MASTER = "unit-test-master-key-32chars-min!!";
const ACCOUNT_NO = "12345678-01";
const USER_ID = "user-sv-test";
const ACCOUNT_ID = "acct-sv-test";

const SECRET = {
  appKey: "paper-app-key-xxxxxxxx",
  appSecret: "paper-app-secret-xxxxxxxxxxxx",
  accountNo: ACCOUNT_NO,
};

before(() => {
  delete process.env.DATABASE_URL;
  process.env.BROKER_CREDENTIAL_MASTER_KEY = MASTER;
  resetDbClientForTest();
});

after(() => {
  if (PREV_URL == null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREV_URL;
  if (PREV_MASTER == null) delete process.env.BROKER_CREDENTIAL_MASTER_KEY;
  else process.env.BROKER_CREDENTIAL_MASTER_KEY = PREV_MASTER;
  resetDbClientForTest();
});

function fingerprint(): string {
  return paperPhysicalAccountFingerprint(ACCOUNT_NO);
}

function mockAccount() {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    environment: "PAPER",
    status: "ACTIVE",
    accountNumberMasked: "****5678",
    physicalAccountFingerprint: fingerprint(),
  };
}

function mockScope(): RuntimeScope {
  const client = new KisClient(kisConfigFromPaperCredentials(SECRET));
  return {
    userId: USER_ID,
    brokerAccountId: ACCOUNT_ID,
    environment: "PAPER",
    statePath: "/tmp/sv-state.json",
    strategyPath: "/tmp/sv-strategy.json",
    lockPath: "/tmp/sv-lock",
    kisClient: client,
    persistState: async () => undefined,
    startupSyncDone: true,
    quoteHub: null,
  };
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    positions: [],
    cash: 1_000_000,
    totalDeposit: 0,
    orders: [],
    quotes: {},
    allocations: [],
    conditions: [],
    dcaPlans: [],
    equityHistory: [],
    tickCount: 0,
    updatedAt: new Date().toISOString(),
    settings: {
      ignoreMarketHours: false,
      startingCash: 0,
      broker: "kis",
      autoTrading: false,
      onboardingComplete: true,
      liquidating: false,
      disclaimerAccepted: true,
      risk: { maxDailyLoss: 0, maxPositionPct: 0 },
    },
    kisBalance: {
      cash: 5_000_000,
      d2Cash: 5_000_000,
      orderableCash: 4_500_000,
      holdings: [],
      syncedAt: new Date().toISOString(),
      cashDelta: 0,
      matched: true,
      message: "ok",
    },
    ...overrides,
  } as AppState;
}

const GOOD_BALANCE = {
  cash: 5_000_000,
  holdings: [] as Array<{ ticker: string; name: string; qty: number; avgPrice: number }>,
  paginationComplete: true,
  pagesFetched: 1,
  orderableCash: 4_500_000,
};

async function runVerify(
  extra: Partial<Parameters<typeof verifyPaperAccountForUser>[0]> = {},
) {
  return verifyPaperAccountForUser({
    userId: USER_ID,
    mockAccount: mockAccount(),
    mockSecret: SECRET,
    mockRuntimeScope: mockScope(),
    mockBalance: GOOD_BALANCE,
    state: baseState(),
    ...extra,
  });
}

test("SV1 RuntimeScope absent → ready=false", async () => {
  const result = await runVerify({ mockRuntimeScope: null });
  assert.equal(result.readyForTrading, false);
  assert.equal(result.runtimeClientVerified, false);
  assert.ok(result.blockers.includes("RUNTIME_SCOPE_MISSING"));
});

test("SV2 runtimeClientVerified=false → ready=false", async () => {
  const scope = mockScope();
  // Wrong CANO → mismatch
  const badClient = new KisClient(
    kisConfigFromPaperCredentials({ ...SECRET, accountNo: "87654321-01" }),
  );
  const badScope = { ...scope, kisClient: badClient };
  const result = await runVerify({ mockRuntimeScope: badScope });
  assert.equal(result.readyForTrading, false);
  assert.equal(result.runtimeClientVerified, false);
  assert.ok(result.blockers.includes("RUNTIME_SCOPE_ACCOUNT_MISMATCH"));
});

test("SV3 state=null → ready=false", async () => {
  const result = await runVerify({ state: null });
  assert.equal(result.readyForTrading, false);
  assert.ok(result.blockers.includes("LOCAL_TRADING_STATE_UNAVAILABLE"));
});

test("SV4 state.kisBalance missing → ready=false", async () => {
  const state = baseState();
  delete (state as { kisBalance?: unknown }).kisBalance;
  const result = await runVerify({ state });
  assert.equal(result.readyForTrading, false);
  assert.ok(result.blockers.includes("LOCAL_BROKER_SNAPSHOT_MISSING"));
});

test("SV5 position exact mismatch → ready=false", async () => {
  const result = await runVerify({
    state: baseState({
      positions: [
        { code: "005930", name: "삼성전자", qty: 2, avgPrice: 70_000, ruleId: "cash" },
      ],
    }),
    mockBalance: { ...GOOD_BALANCE, holdings: [] },
  });
  assert.equal(result.readyForTrading, false);
  assert.equal(result.localPositionsMatched, false);
  assert.ok(result.blockers.includes("POSITION_QTY_MISMATCH"));
});

test("SV6 deposit mismatch → ready=false", async () => {
  const result = await runVerify({
    state: baseState({
      kisBalance: {
        cash: 1_000_000,
        d2Cash: 1_000_000,
        orderableCash: 4_500_000,
        holdings: [],
        syncedAt: new Date().toISOString(),
        cashDelta: 0,
        matched: true,
        message: "ok",
      },
    }),
  });
  assert.equal(result.readyForTrading, false);
  assert.equal(result.depositSnapshotMatched, false);
  assert.ok(result.blockers.includes("KIS_BALANCE_CASH_MISMATCH"));
});

test("SV7 orderable missing → ready=false", async () => {
  const result = await runVerify({
    mockBalance: {
      cash: 5_000_000,
      holdings: [],
      paginationComplete: true,
      orderableCash: undefined as unknown as number,
    },
  });
  assert.equal(result.readyForTrading, false);
  assert.ok(result.blockers.includes("ORDERABLE_CASH_UNAVAILABLE"));
});

test("SV8 orderable mismatch → ready=false", async () => {
  const result = await runVerify({
    state: baseState({
      kisBalance: {
        cash: 5_000_000,
        d2Cash: 5_000_000,
        orderableCash: 1_000_000,
        holdings: [],
        syncedAt: new Date().toISOString(),
        cashDelta: 0,
        matched: true,
        message: "ok",
      },
    }),
  });
  assert.equal(result.readyForTrading, false);
  assert.equal(result.orderableSnapshotMatched, false);
  assert.ok(result.blockers.includes("KIS_ORDERABLE_CASH_MISMATCH"));
});

test("SV9 everything exact → ready=true", async () => {
  const result = await runVerify({
    state: baseState({
      positions: [
        { code: "005930", name: "삼성전자", qty: 1, avgPrice: 70_000, ruleId: "cash" },
      ],
    }),
    mockBalance: {
      ...GOOD_BALANCE,
      holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 70_000 }],
    },
  });
  assert.equal(result.runtimeClientVerified, true);
  assert.equal(result.localPositionsMatched, true);
  assert.equal(result.depositSnapshotMatched, true);
  assert.equal(result.orderableSnapshotMatched, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.readyForTrading, true);
});

test("runtimeResolutionFailed cannot be READY", async () => {
  const result = await runVerify({ runtimeResolutionFailed: true });
  assert.equal(result.readyForTrading, false);
  assert.ok(result.blockers.includes("RUNTIME_RESOLUTION_FAILED"));
});
