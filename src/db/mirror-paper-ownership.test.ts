import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { MemoryLedger } from "@/src/db/ledger";
import {
  MirrorPaperOwnershipError,
  planMirrorPaperBrokerAccount,
} from "@/src/db/mirror-paper-ownership";
import { projectAppState } from "@/src/db/projector";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { resetPaperRuntimeOwnerForTest } from "@/src/runtime/paper-runtime-owner";

const MASTER = "test-broker-credential-master-key-32chars!!";

function withMaster(env: Record<string, string>): Record<string, string> {
  return { ...env, BROKER_CREDENTIAL_MASTER_KEY: MASTER };
}

test("MI1 accounts owner → fresh bootstrap ACTIVE row 없음", async () => {
  resetPaperRuntimeOwnerForTest();
  const plan = planMirrorPaperBrokerAccount("kis", "PAPER", {
    PAPER_RUNTIME_OWNER: "accounts",
  });
  assert.equal(plan.status, "DISABLED");
  assert.equal(plan.physicalAccountFingerprint, null);
  assert.equal(plan.isDefault, false);

  const ledger = new MemoryLedger();
  const result = await projectAppState(ledger, createPaperState(), {
    env: {
      BROKER: "kis",
      KIS_MODE: "paper",
      TRADING_MODE: "paper",
      PAPER_RUNTIME_OWNER: "accounts",
      PERSISTENCE_MODE: "mirror",
    },
  });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  const paper = accounts.filter(
    (row) => row.environment === "PAPER" && row.broker.toLowerCase() === "kis",
  );
  assert.ok(paper.length >= 1);
  assert.ok(paper.every((row) => row.status === "DISABLED"));
  assert.ok(paper.every((row) => row.physicalAccountFingerprint == null));
  assert.ok(result.brokerAccountId);
});

test("MI2 existing DISABLED bootstrap remains DISABLED on remirror", async () => {
  resetPaperRuntimeOwnerForTest();
  const ledger = new MemoryLedger();
  const env = {
    BROKER: "kis",
    KIS_MODE: "paper",
    TRADING_MODE: "paper",
    PAPER_RUNTIME_OWNER: "accounts",
    PERSISTENCE_MODE: "mirror",
  };
  await projectAppState(ledger, createPaperState(), { env });
  await projectAppState(ledger, createPaperState(), { env });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  const paper = accounts.filter((row) => row.environment === "PAPER");
  assert.ok(paper.every((row) => row.status === "DISABLED"));
});

test("MI3 bootstrap owner → ACTIVE row requires fingerprint", async () => {
  resetPaperRuntimeOwnerForTest();
  process.env.BROKER_CREDENTIAL_MASTER_KEY = MASTER;
  const accountNo = "50123456-01";
  const plan = planMirrorPaperBrokerAccount(
    "kis",
    "PAPER",
    withMaster({
      PAPER_RUNTIME_OWNER: "bootstrap",
      KIS_PAPER_ACCOUNT_NO: accountNo,
      KIS_PAPER_APP_KEY: "k".repeat(10),
      KIS_PAPER_APP_SECRET: "s".repeat(10),
    }),
  );
  assert.equal(plan.status, "ACTIVE");
  assert.equal(plan.physicalAccountFingerprint, paperPhysicalAccountFingerprint(accountNo));

  const ledger = new MemoryLedger();
  await projectAppState(ledger, createPaperState(), {
    env: withMaster({
      BROKER: "kis",
      KIS_MODE: "paper",
      TRADING_MODE: "paper",
      PAPER_RUNTIME_OWNER: "bootstrap",
      KIS_PAPER_ACCOUNT_NO: accountNo,
      KIS_PAPER_APP_KEY: "k".repeat(10),
      KIS_PAPER_APP_SECRET: "s".repeat(10),
    }),
  });
  const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
  const active = accounts.find((row) => row.status === "ACTIVE" && row.environment === "PAPER");
  assert.ok(active);
  assert.equal(active.physicalAccountFingerprint, paperPhysicalAccountFingerprint(accountNo));
});

test("MI4 bootstrap owner + accountNo absent → fail closed", () => {
  resetPaperRuntimeOwnerForTest();
  assert.throws(
    () =>
      planMirrorPaperBrokerAccount(
        "kis",
        "PAPER",
        withMaster({
          PAPER_RUNTIME_OWNER: "bootstrap",
          KIS_PAPER_ACCOUNT_NO: "",
        }),
      ),
    (err: unknown) => err instanceof MirrorPaperOwnershipError,
  );
});

test("MI5 mirror repeated → ownership unchanged under accounts", async () => {
  resetPaperRuntimeOwnerForTest();
  const ledger = new MemoryLedger();
  const env = {
    BROKER: "kis",
    KIS_MODE: "paper",
    TRADING_MODE: "paper",
    PAPER_RUNTIME_OWNER: "accounts",
  };
  await projectAppState(ledger, createPaperState(), { env });
  const first = await ledger.transaction((tx) => tx.listBrokerAccounts());
  await projectAppState(ledger, createPaperState(), { env });
  const second = await ledger.transaction((tx) => tx.listBrokerAccounts());
  assert.deepEqual(
    first.map((row) => ({
      id: row.id,
      status: row.status,
      fp: row.physicalAccountFingerprint ?? null,
    })),
    second.map((row) => ({
      id: row.id,
      status: row.status,
      fp: row.physicalAccountFingerprint ?? null,
    })),
  );
});

test("ACTIVE PAPER + NULL fingerprint rejected by MemorySession upsert", async () => {
  const ledger = new MemoryLedger();
  await assert.rejects(
    () =>
      ledger.transaction((tx) =>
        tx.upsertBrokerAccount({
          id: "acc-bad",
          userId: "user-1",
          broker: "kis",
          environment: "PAPER",
          displayName: "bad",
          accountNumberMasked: "****",
          baseCurrency: "KRW",
          status: "ACTIVE",
          isDefault: true,
          credentialRef: "env:KIS_PAPER",
          physicalAccountFingerprint: null,
        }),
      ),
    /physicalAccountFingerprint/,
  );
});
