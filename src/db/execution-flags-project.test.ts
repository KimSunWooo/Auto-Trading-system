/**
 * Stale ON book must not resurrect autoTrading after a committed RDS OFF
 * during full / tick / Intent (persistTradingLedger) projects.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { MemoryLedger } from "@/src/db/ledger";
import { resetPersistGenerationForTest } from "@/src/db/ledger-tx";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import { projectAppState } from "@/src/db/projector";
import {
  persistTradingLedger,
  persistUserExecutionSettingsFlags,
} from "@/src/db/persist";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";

const ACCOUNT = "dddddddd-eeee-ffff-0000-111111111111";
const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function paperEnv() {
  return {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test",
    PERSISTENCE_MODE: "database",
    KIS_MODE: "paper",
    BROKER: "kis",
  };
}

function seedAccount(ledger: MemoryLedger) {
  const fp = paperPhysicalAccountFingerprint("50206021");
  ledger.snapshot.users.set(USER, {
    id: USER,
    email: "flags-project@test.local",
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

async function readFlag(ledger: MemoryLedger): Promise<boolean | undefined> {
  return ledger.transaction(async (tx) => {
    const row = await tx.getTradingAccountState(ACCOUNT);
    return row?.autoTradingEnabled;
  });
}

afterEach(() => {
  setMirrorLedgerForTest(null);
  resetPersistGenerationForTest();
  delete process.env.PERSISTENCE_MODE;
});

test("full projectAppState with stale ON does not overwrite committed OFF", async () => {
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  const on = createPaperState();
  on.settings.autoTrading = true;
  on.settings.onboardingComplete = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, env);
  assert.equal(await readFlag(ledger), true);

  const off = createPaperState();
  off.settings.autoTrading = false;
  await persistUserExecutionSettingsFlags(off, ACCOUNT, env);
  assert.equal(await readFlag(ledger), false);

  // Stale in-flight book still believes ON (full Intent/durable path).
  const staleOn = createPaperState();
  staleOn.settings.autoTrading = true;
  await projectAppState(ledger, staleOn, {
    brokerAccountId: ACCOUNT,
    env,
    projectMode: "full",
  });
  assert.equal(await readFlag(ledger), false, "full project must preserve RDS OFF");
});

test("tick projectAppState with stale ON does not overwrite committed OFF", async () => {
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  const on = createPaperState();
  on.settings.autoTrading = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, env);
  const off = createPaperState();
  off.settings.autoTrading = false;
  await persistUserExecutionSettingsFlags(off, ACCOUNT, env);

  const staleOn = createPaperState();
  staleOn.settings.autoTrading = true;
  await projectAppState(ledger, staleOn, {
    brokerAccountId: ACCOUNT,
    env,
    projectMode: "tick",
  });
  assert.equal(await readFlag(ledger), false);
});

test("persistTradingLedger Intent/full path keeps committed OFF", async () => {
  const ledger = new MemoryLedger();
  seedAccount(ledger);
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  const on = createPaperState();
  on.settings.autoTrading = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, env);
  const off = createPaperState();
  off.settings.autoTrading = false;
  await persistUserExecutionSettingsFlags(off, ACCOUNT, env);

  const intentBook = createPaperState();
  intentBook.settings.autoTrading = true;
  intentBook.intents = [
    {
      intentId: "sig:test:stale-on",
      signalId: "sig:test:stale-on",
      ruleId: "cash",
      ticker: "005930",
      side: "buy",
      qty: 1,
      price: 70_000,
      createdAt: new Date().toISOString(),
      reason: "intent-persist",
      status: "pending",
    },
  ];
  await persistTradingLedger(intentBook, env, {
    brokerAccountId: ACCOUNT,
    projectMode: "full",
  });
  assert.equal(await readFlag(ledger), false, "Intent persist must not resurrect ON");
});
