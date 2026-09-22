/**
 * O1–O8 PAPER runtime ownership + physical account uniqueness.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startAccountEngineLoop, stopAccountEngineLoopForTest } from "@/lib/account-engine-loop";
import { startEngineLoop, stopEngineLoopForTest } from "@/lib/engine-loop";
import {
  findDuplicateActivePaperPhysicalAccount,
  normalizePaperAccountIdentity,
} from "@/src/runtime/paper-physical-account";
import {
  gatePaperWorkerStart,
  PaperRuntimeOwnerError,
  planPaperRuntimeStarts,
  resetPaperRuntimeOwnerForTest,
  resolvePaperRuntimeOwner,
  startPaperRuntimeWorkers,
} from "@/src/runtime/paper-runtime-owner";

test.beforeEach(() => {
  resetPaperRuntimeOwnerForTest();
  stopEngineLoopForTest();
  stopAccountEngineLoopForTest();
  delete process.env.PAPER_RUNTIME_OWNER;
});

test.afterEach(() => {
  resetPaperRuntimeOwnerForTest();
  stopEngineLoopForTest();
  stopAccountEngineLoopForTest();
  delete process.env.PAPER_RUNTIME_OWNER;
});

test("O1 owner=bootstrap → bootstrap START, accounts BLOCKED", () => {
  process.env.PAPER_RUNTIME_OWNER = "bootstrap";
  const boot = startEngineLoop();
  const acct = startAccountEngineLoop();
  assert.equal(boot.allowed, true);
  assert.equal(acct.allowed, false);
  assert.match(String(acct.reason), /refuses accounts/);
});

test("O2 owner=accounts → accounts START, bootstrap BLOCKED", () => {
  process.env.PAPER_RUNTIME_OWNER = "accounts";
  const boot = startEngineLoop();
  const acct = startAccountEngineLoop();
  assert.equal(boot.allowed, false);
  assert.match(String(boot.reason), /refuses bootstrap/);
  assert.equal(acct.allowed, true);
});

test("O3 owner=disabled → both BLOCKED", () => {
  process.env.PAPER_RUNTIME_OWNER = "disabled";
  const boot = startEngineLoop();
  const acct = startAccountEngineLoop();
  assert.equal(boot.allowed, false);
  assert.equal(acct.allowed, false);
});

test("O4 invalid owner → both BLOCKED + explicit configuration error", () => {
  process.env.PAPER_RUNTIME_OWNER = "both";
  const resolved = resolvePaperRuntimeOwner(process.env, { freeze: false, log: () => {} });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.match(resolved.error, /Invalid PAPER_RUNTIME_OWNER/);
  }
  const boot = startEngineLoop();
  const acct = startAccountEngineLoop();
  assert.equal(boot.allowed, false);
  assert.equal(acct.allowed, false);
  assert.match(String(boot.reason), /Invalid PAPER_RUNTIME_OWNER/);
});

test("O5 instrumentation owner=bootstrap → only bootstrap start invoked", () => {
  const calls: string[] = [];
  const plan = startPaperRuntimeWorkers(
    {
      startBootstrap: () => calls.push("bootstrap"),
      startAccounts: () => calls.push("accounts"),
    },
    { PAPER_RUNTIME_OWNER: "bootstrap" },
    { log: () => {} },
  );
  assert.equal(plan.bootstrap, true);
  assert.equal(plan.accounts, false);
  assert.deepEqual(calls, ["bootstrap"]);
});

test("O6 instrumentation owner=accounts → only account start invoked", () => {
  const calls: string[] = [];
  const plan = startPaperRuntimeWorkers(
    {
      startBootstrap: () => calls.push("bootstrap"),
      startAccounts: () => calls.push("accounts"),
    },
    { PAPER_RUNTIME_OWNER: "accounts" },
    { log: () => {} },
  );
  assert.equal(plan.bootstrap, false);
  assert.equal(plan.accounts, true);
  assert.deepEqual(calls, ["accounts"]);
});

test("O7 instrumentation owner=disabled → no worker starts", () => {
  const calls: string[] = [];
  const plan = startPaperRuntimeWorkers(
    {
      startBootstrap: () => calls.push("bootstrap"),
      startAccounts: () => calls.push("accounts"),
    },
    { PAPER_RUNTIME_OWNER: "disabled" },
    { log: () => {} },
  );
  assert.equal(plan.bootstrap, false);
  assert.equal(plan.accounts, false);
  assert.deepEqual(calls, []);
});

test("O8 direct call defense across owners", () => {
  process.env.PAPER_RUNTIME_OWNER = "accounts";
  assert.equal(startEngineLoop().allowed, false);
  resetPaperRuntimeOwnerForTest();
  process.env.PAPER_RUNTIME_OWNER = "bootstrap";
  assert.equal(startAccountEngineLoop().allowed, false);
});

test("unset PAPER_RUNTIME_OWNER defaults to bootstrap with warning", () => {
  const logs: string[] = [];
  const resolved = resolvePaperRuntimeOwner({}, { log: (l) => logs.push(l), freeze: false });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.owner, "bootstrap");
    assert.equal(resolved.usedUnsetDefault, true);
  }
  assert.ok(logs.some((l) => /unset → bootstrap compatibility mode/.test(l)));
});

test("hot switch ignored after freeze — restart required", () => {
  const logs: string[] = [];
  const a = resolvePaperRuntimeOwner(
    { PAPER_RUNTIME_OWNER: "bootstrap" },
    { log: (l) => logs.push(l) },
  );
  assert.equal(a.ok, true);
  const b = resolvePaperRuntimeOwner(
    { PAPER_RUNTIME_OWNER: "accounts" },
    { log: (l) => logs.push(l) },
  );
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.equal(b.owner, "bootstrap");
    assert.equal(b.locked, true);
  }
  assert.ok(logs.some((l) => /hot switch ignored/.test(l)));
});

test("invalid instrumentation owner throws and starts nothing", () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      startPaperRuntimeWorkers(
        {
          startBootstrap: () => calls.push("bootstrap"),
          startAccounts: () => calls.push("accounts"),
        },
        { PAPER_RUNTIME_OWNER: "everybody" },
        { log: () => {} },
      ),
    (err: unknown) => err instanceof PaperRuntimeOwnerError,
  );
  assert.deepEqual(calls, []);
});

test("same physical PAPER CANO — only one ACTIVE ownership", () => {
  assert.equal(normalizePaperAccountIdentity("5012-3456-01"), "5012345601");
  const dup = findDuplicateActivePaperPhysicalAccount(
    [
      { id: "a1", identity: "50123456-01", status: "ACTIVE", environment: "PAPER" },
      { id: "a2", identity: "99999999-01", status: "ACTIVE", environment: "PAPER" },
    ],
    "5012-3456-01",
  );
  assert.equal(dup, "a1");

  const disabledOk = findDuplicateActivePaperPhysicalAccount(
    [{ id: "a1", identity: "50123456-01", status: "DISABLED", environment: "PAPER" }],
    "50123456-01",
  );
  assert.equal(disabledOk, null);

  const excludeSelf = findDuplicateActivePaperPhysicalAccount(
    [{ id: "a1", identity: "50123456-01", status: "ACTIVE", environment: "PAPER" }],
    "50123456-01",
    { excludeBrokerAccountId: "a1" },
  );
  assert.equal(excludeSelf, null);
});

test("same CANO cross-runtime: exclusive owner is order-capable", () => {
  // Fixture: bootstrap .env CANO equals user account CANO — ownership mode decides who may run.
  const sameCano = "11111111-01";
  assert.equal(normalizePaperAccountIdentity(sameCano), "1111111101");

  resetPaperRuntimeOwnerForTest();
  const bootstrapPlan = planPaperRuntimeStarts(
    { PAPER_RUNTIME_OWNER: "bootstrap" },
    { log: () => {}, freeze: false },
  );
  assert.equal(bootstrapPlan.bootstrap, true);
  assert.equal(bootstrapPlan.accounts, false);

  resetPaperRuntimeOwnerForTest();
  const accountsPlan = planPaperRuntimeStarts(
    { PAPER_RUNTIME_OWNER: "accounts" },
    { log: () => {}, freeze: false },
  );
  assert.equal(accountsPlan.bootstrap, false);
  assert.equal(accountsPlan.accounts, true);

  resetPaperRuntimeOwnerForTest();
  process.env.PAPER_RUNTIME_OWNER = "accounts";
  assert.equal(gatePaperWorkerStart("bootstrap").allowed, false);
  assert.equal(gatePaperWorkerStart("accounts").allowed, true);
});
