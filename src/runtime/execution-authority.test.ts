/**
 * Cross-process execution authority: Worker/UI must use committed RDS flags,
 * not a stale in-process book cache. MemoryLedger only — no live orders.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { MemoryLedger } from "@/src/db/ledger";
import { resetPersistGenerationForTest } from "@/src/db/ledger-tx";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import {
  DatabaseLedgerError,
  persistUserExecutionSettingsFlags,
  setFlagsPersistHoldForTest,
} from "@/src/db/persist";
import {
  applyExecutionAuthority,
  executionAuthorityBlocksTrading,
  readExecutionAuthorityFromRds,
} from "@/src/runtime/execution-authority";
import {
  createTradingStateStore,
  resetTradingStateStoresForTest,
} from "@/src/runtime/trading-state-store";
import { EMPTY_RULE_CONFIG } from "@/src/rules/params";
import { tradingBlocked } from "@/src/risk/circuit";

const ACCOUNT = "cccccccc-dddd-eeee-ffff-000000000001";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function paperEnv() {
  return {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test",
    PERSISTENCE_MODE: "database",
  };
}

function seedBrokerAccount(ledger: MemoryLedger): void {
  const fp = paperPhysicalAccountFingerprint("50206021");
  ledger.snapshot.users.set(USER_ID, {
    id: USER_ID,
    email: "exec-auth@test.local",
    displayName: "test",
    role: "USER",
    status: "ACTIVE",
    createdAt: "2026-01-01 00:00:00.000000",
    updatedAt: "2026-01-01 00:00:00.000000",
  });
  ledger.snapshot.brokerAccounts.set(ACCOUNT, {
    id: ACCOUNT,
    userId: USER_ID,
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

afterEach(() => {
  setFlagsPersistHoldForTest(null);
  setMirrorLedgerForTest(null);
  resetPersistGenerationForTest();
  resetTradingStateStoresForTest();
  delete process.env.PERSISTENCE_MODE;
});

function seedStoreOnDisk(dir: string, autoTrading: boolean): string {
  const accountsDir = path.join(dir, "accounts", ACCOUNT);
  mkdirSync(accountsDir, { recursive: true });
  const statePath = path.join(accountsDir, "state.json");
  const state = createPaperState();
  state.settings.autoTrading = autoTrading;
  state.settings.onboardingComplete = true;
  state.settings.disclaimerAccepted = true;
  writeFileSync(statePath, JSON.stringify(state), "utf8");
  return statePath;
}

test("stale in-memory ON loses to RDS OFF on worker tick (cross-process)", async () => {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test";

  const ledger = new MemoryLedger();
  seedBrokerAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();
  const dir = mkdtempSync(path.join(os.tmpdir(), "exec-auth-"));

  try {
    // Shared RDS starts ON (as if another process enabled trading).
    const on = createPaperState();
    on.settings.autoTrading = true;
    on.settings.onboardingComplete = true;
    await persistUserExecutionSettingsFlags(on, ACCOUNT, env);

    // Process A (worker): warm in-process cache from RDS ON.
    const workerPath = seedStoreOnDisk(dir, true);
    const worker = createTradingStateStore({
      statePath: workerPath,
      brokerAccountId: ACCOUNT,
      skipPersistUnderTest: true,
    });
    const warmed = await worker.getState();
    assert.equal(warmed.settings.autoTrading, true);

    // Process B: commit OFF to shared RDS (independent of worker memory).
    const off = createPaperState();
    off.settings.autoTrading = false;
    off.settings.onboardingComplete = true;
    await persistUserExecutionSettingsFlags(off, ACCOUNT, env);
    const rds = await readExecutionAuthorityFromRds(ACCOUNT, env);
    assert.equal(rds.source, "rds");
    assert.equal(rds.autoTrading, false);

    // Reproduce: getState still serves stale in-process ON.
    const cached = await worker.getState();
    assert.equal(cached.settings.autoTrading, true, "reproduce: cache still ON before tick");

    const publicState = await worker.tickAndGet(EMPTY_RULE_CONFIG, {
      source: "worker",
      tickDeps: { startupSyncVerified: true },
    });
    assert.equal(
      publicState.runtime.operatorAutoTrading,
      false,
      "worker tick must apply committed RDS OFF",
    );
    const after = await worker.getState();
    assert.equal(after.settings.autoTrading, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard getPublicState keeps book cache (no per-poll RDS authority round-trip)", async () => {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test";

  const ledger = new MemoryLedger();
  seedBrokerAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();
  const dir = mkdtempSync(path.join(os.tmpdir(), "exec-auth-ui-"));

  try {
    const on = createPaperState();
    on.settings.autoTrading = true;
    await persistUserExecutionSettingsFlags(on, ACCOUNT, env);

    const statePath = seedStoreOnDisk(dir, true);
    const store = createTradingStateStore({
      statePath,
      brokerAccountId: ACCOUNT,
      skipPersistUnderTest: true,
    });
    await store.getState();

    const off = createPaperState();
    off.settings.autoTrading = false;
    await persistUserExecutionSettingsFlags(off, ACCOUNT, env);

    // Cache may still show ON until worker tick — intentional for dashboard speed.
    assert.equal((await store.getState()).settings.autoTrading, true, "cache still ON");
    const pub = await store.getPublicState(EMPTY_RULE_CONFIG);
    assert.equal(pub.runtime.operatorAutoTrading, true);

    // Worker path must still force OFF for the next order decision.
    const tick = await store.tickAndGet(EMPTY_RULE_CONFIG, {
      source: "worker",
      tickDeps: { startupSyncVerified: true },
    });
    assert.equal(tick.runtime.operatorAutoTrading, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncommitted ON (held before commit) is invisible to Worker and UI", async () => {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test";

  const ledger = new MemoryLedger();
  seedBrokerAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();
  const dir = mkdtempSync(path.join(os.tmpdir(), "exec-auth-hold-"));

  try {
    const offSeed = createPaperState();
    offSeed.settings.autoTrading = false;
    offSeed.settings.onboardingComplete = true;
    await persistUserExecutionSettingsFlags(offSeed, ACCOUNT, env);

    const statePath = seedStoreOnDisk(dir, false);
    const store = createTradingStateStore({
      statePath,
      brokerAccountId: ACCOUNT,
      skipPersistUnderTest: false,
    });
    await store.getState();

    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let enteredHold = false;
    setFlagsPersistHoldForTest(async () => {
      enteredHold = true;
      await holdGate;
    });

    let cancelled = false;
    const onPromise = store.mutateStore(
      (s) => ({
        ...s,
        settings: { ...s.settings, autoTrading: true },
      }),
      {
        projectMode: "flags",
        isAllowed: () => !cancelled,
      },
    );

    for (let i = 0; i < 200 && !enteredHold; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(enteredHold, true);

    // Mid-flight: memory + RDS must still look OFF.
    const midMem = await store.getState();
    assert.equal(midMem.settings.autoTrading, false, "memory must not show uncommitted ON");
    const midPub = await store.getPublicState(EMPTY_RULE_CONFIG);
    assert.equal(midPub.runtime.operatorAutoTrading, false);
    const midTick = await store.tickAndGet(EMPTY_RULE_CONFIG, {
      source: "worker",
      tickDeps: { startupSyncVerified: true },
    });
    assert.equal(midTick.runtime.operatorAutoTrading, false);

    cancelled = true;
    releaseHold();
    await assert.rejects(
      () => onPromise,
      (err: unknown) =>
        err instanceof DatabaseLedgerError &&
        /cancelled|superseded|OFF supersedes/i.test(err.message),
    );

    const finalMem = await store.getState();
    assert.equal(finalMem.settings.autoTrading, false);
    const auth = await readExecutionAuthorityFromRds(ACCOUNT, env);
    assert.equal(auth.autoTrading, false);
  } finally {
    setFlagsPersistHoldForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RDS unavailable blocks new orders via executionAuthorityOk", () => {
  const state = createPaperState();
  state.settings.autoTrading = true;
  state.settings.disclaimerAccepted = true;
  const block = tradingBlocked(state, {
    startupSyncVerified: true,
    executionAuthorityOk: false,
    executionAuthorityBlockReason: "RDS 실행 설정을 확인할 수 없어 신규 주문을 차단합니다.",
  });
  assert.match(String(block), /RDS 실행 설정/);
});

test("applyExecutionAuthority + unresolved order risk helpers", () => {
  const state = createPaperState();
  state.settings.autoTrading = true;
  const applied = applyExecutionAuthority(state, {
    source: "rds",
    autoTrading: false,
    liquidating: false,
    onboardingComplete: true,
    circuit: { halted: false, unknownCount: 0 },
    hasUnresolvedOrderRisk: false,
  });
  assert.equal(applied.settings.autoTrading, false);

  assert.equal(
    executionAuthorityBlocksTrading({
      source: "unavailable",
      autoTrading: null,
      liquidating: null,
      onboardingComplete: null,
      circuit: null,
      hasUnresolvedOrderRisk: null,
      error: "down",
    }),
    "down",
  );
  assert.match(
    String(
      executionAuthorityBlocksTrading({
        source: "rds",
        autoTrading: true,
        liquidating: false,
        onboardingComplete: true,
        circuit: { halted: false, unknownCount: 0 },
        hasUnresolvedOrderRisk: true,
      }),
    ),
    /미확인|미완료/,
  );
});
