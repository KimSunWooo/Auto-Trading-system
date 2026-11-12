/**
 * Server-restart lost-request recovery + OFF-vs-ON flags persist races.
 * Uses MemoryLedger only — no live orders, no REAL, no worker start.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { MemoryLedger } from "@/src/db/ledger";
import { resetPersistGenerationForTest } from "@/src/db/ledger-tx";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import {
  DatabaseLedgerError,
  persistUserExecutionSettingsFlags,
  setFlagsPersistHoldForTest,
} from "@/src/db/persist";
import {
  buildLostStartRequestRecovery,
  cancelAutoTradingStartJobsForAccount,
  clearAutoTradingStartJobsForTest,
  enqueueAutoTradingStart,
  getAutoTradingStartGeneration,
  readAccountAutoTradingFromRds,
} from "@/src/runtime/auto-trading-start-job";

const ACCOUNT = "acct-paper-start-recovery";

function paperEnv() {
  return {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "mysql://127.0.0.1:3306/auto_trading_test",
    PERSISTENCE_MODE: "database",
  };
}

async function readFlag(ledger: MemoryLedger, accountId: string): Promise<boolean | undefined> {
  return ledger.transaction(async (tx) => {
    const row = await tx.getTradingAccountState(accountId);
    return row?.autoTradingEnabled;
  });
}

afterEach(() => {
  setFlagsPersistHoldForTest(null);
  setMirrorLedgerForTest(null);
  clearAutoTradingStartJobsForTest();
  resetPersistGenerationForTest();
});

test("lost requestId before ON save → 현재 OFF, previous unknown, no retransmit", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  const recovery = await buildLostStartRequestRecovery("start-lost-off", ACCOUNT);
  assert.equal(recovery.errorCode, "START_REQUEST_LOST");
  assert.equal(recovery.previousRequestStatus, "unknown");
  assert.equal(recovery.accountAutoTrading, false);
  assert.equal(recovery.accountAutoTradingSource, "rds");
  assert.equal(recovery.uiStatus, "현재 OFF");
  assert.equal(recovery.autoRetransmit, false);
  assert.equal(recovery.status, "lost");
});

test("lost requestId after ON save → 현재 ON distinct from previous completion", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  const on = createPaperState();
  on.settings.autoTrading = true;
  on.settings.onboardingComplete = true;
  await persistUserExecutionSettingsFlags(on, ACCOUNT, paperEnv());
  const rds = await readAccountAutoTradingFromRds(ACCOUNT);
  assert.equal(rds.source, "rds");
  assert.equal(rds.autoTrading, true);

  const recovery = await buildLostStartRequestRecovery("start-lost-on", ACCOUNT);
  assert.equal(recovery.previousRequestStatus, "unknown");
  assert.equal(recovery.accountAutoTrading, true);
  assert.equal(recovery.uiStatus, "현재 ON");
  assert.equal(recovery.autoRetransmit, false);
});

test("lost requestId when RDS unavailable → 확인 불가", async () => {
  setMirrorLedgerForTest(null);
  const recovery = await buildLostStartRequestRecovery("start-lost-rds-fail", ACCOUNT);
  assert.equal(recovery.accountAutoTrading, null);
  assert.equal(recovery.accountAutoTradingSource, "unavailable");
  assert.equal(recovery.uiStatus, "확인 불가");
  assert.equal(recovery.autoRetransmit, false);
  assert.match(recovery.message, /확인하지 못했습니다/);
});

test("OFF during ON hold before commit → 0 ON commits; final OFF", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  let releaseHold!: () => void;
  const holdGate = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let enteredHold = false;

  let cancelled = false;
  const onState = createPaperState();
  onState.settings.autoTrading = true;
  onState.settings.onboardingComplete = true;

  // Per-call hold only — do not use the global hook (OFF must not wait on the same gate).
  const onPromise = persistUserExecutionSettingsFlags(onState, ACCOUNT, env, {
    isAllowed: () => !cancelled,
    holdBeforeCommit: async () => {
      enteredHold = true;
      await holdGate;
    },
  });

  for (let i = 0; i < 200 && !enteredHold; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(enteredHold, true, "ON persist must reach holdBeforeCommit");

  cancelled = true;
  cancelAutoTradingStartJobsForAccount(ACCOUNT);
  const offState = createPaperState();
  offState.settings.autoTrading = false;
  await persistUserExecutionSettingsFlags(offState, ACCOUNT, env);

  releaseHold();
  await assert.rejects(
    () => onPromise,
    (err: unknown) =>
      err instanceof DatabaseLedgerError &&
      /cancelled|superseded|OFF supersedes/i.test(err.message),
  );

  assert.equal(await readFlag(ledger, ACCOUNT), false);
  assert.ok(getAutoTradingStartGeneration(ACCOUNT) >= 1);
});

test("OFF after ON commit → final RDS OFF for workers", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  const onState = createPaperState();
  onState.settings.autoTrading = true;
  await persistUserExecutionSettingsFlags(onState, ACCOUNT, env);
  assert.equal(await readFlag(ledger, ACCOUNT), true);

  cancelAutoTradingStartJobsForAccount(ACCOUNT);
  const offState = createPaperState();
  offState.settings.autoTrading = false;
  await persistUserExecutionSettingsFlags(offState, ACCOUNT, env);

  assert.equal(await readFlag(ledger, ACCOUNT), false);
  const workerView = await readAccountAutoTradingFromRds(ACCOUNT);
  assert.equal(workerView.source, "rds");
  assert.equal(workerView.autoTrading, false);
});

test("new start enqueue bumps generation past cancelled job", () => {
  cancelAutoTradingStartJobsForAccount(ACCOUNT);
  const genAfterCancel = getAutoTradingStartGeneration(ACCOUNT);
  assert.equal(genAfterCancel, 1);

  const { job } = enqueueAutoTradingStart({
    disclaimerAccepted: true,
    rt: {
      user: { id: "user-b" },
      account: { id: ACCOUNT, environment: "PAPER" } as never,
      scope: { lockPath: "/tmp/unused.lock" } as never,
      store: {
        mutateStore: async () => createPaperState(),
        getState: async () => createPaperState(),
      } as never,
      rules: { rules: [] } as never,
    },
  });
  assert.ok(job.generation > genAfterCancel);
  assert.equal(getAutoTradingStartGeneration(ACCOUNT), job.generation);
  // Cancel immediately so the background runner cannot place orders / touch live RDS.
  cancelAutoTradingStartJobsForAccount(ACCOUNT);
});

test("cancelled force-OFF isAllowed gate cannot overwrite newer ON", async () => {
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);
  const env = paperEnv();

  cancelAutoTradingStartJobsForAccount(ACCOUNT);
  const genA = getAutoTradingStartGeneration(ACCOUNT);

  const newOn = createPaperState();
  newOn.settings.autoTrading = true;
  await persistUserExecutionSettingsFlags(newOn, ACCOUNT, env);

  const lateOff = createPaperState();
  lateOff.settings.autoTrading = false;
  await assert.rejects(
    () =>
      persistUserExecutionSettingsFlags(lateOff, ACCOUNT, env, {
        isAllowed: () => getAutoTradingStartGeneration(ACCOUNT) === genA - 1,
      }),
    DatabaseLedgerError,
  );

  assert.equal(await readFlag(ledger, ACCOUNT), true);
});

test("Startup Sync status-only path passes projectMode flags", () => {
  const src = readFileSync(path.join(process.cwd(), "lib/account-engine-loop.ts"), "utf8");
  assert.match(
    src,
    /status:\s*"SYNCING"[\s\S]*?projectMode:\s*"flags"/,
    "SYNCING status persist must use flags",
  );
  assert.match(
    src,
    /status:\s*"FAILED"[\s\S]*?projectMode:\s*"flags"/,
    "FAILED status persist must use flags",
  );
  // Book apply after sync stays on the default (non-flags) mutateStore path.
  assert.match(
    src,
    /Apply sync book under lock[\s\S]*?await store\.mutateStore\(async \(state\) => \(\{[\s\S]*?settings: state\.settings,\s*\}\)\)/,
  );
});
