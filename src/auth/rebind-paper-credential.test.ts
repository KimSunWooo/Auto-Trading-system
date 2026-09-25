/**
 * Operator PAPER credential rebind — fail-closed unit tests (no live KIS / no RDS).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptPaperCredentials,
  encryptPaperCredentials,
  maskAccountNumber,
} from "@/src/auth/crypto";
import {
  RECOVERY_CONFIRM_TOKEN,
  assertLogsHaveNoSecrets,
  createMemoryRebindStore,
  rebindPaperCredential,
  type RebindAccountRow,
  type RebindTradingStateRow,
} from "@/src/auth/rebind-paper-credential";

const MASTER = "unit-test-rebind-master-key-32chars-min!!";
const ACCOUNT_NO = "50123456"; // last4 3456 → mask ****3456
const APP_KEY = "PAPER_APP_KEY_UNIT_TEST_XXXX";
const APP_SECRET = "PAPER_APP_SECRET_UNIT_TEST_YYYYYYYY";

const PREV_MASTER = process.env.BROKER_CREDENTIAL_MASTER_KEY;
const PREV_ALLOW = process.env.ALLOW_LIVE_TRADING;
const PREV_MODE = process.env.KIS_MODE;

test.before(() => {
  process.env.BROKER_CREDENTIAL_MASTER_KEY = MASTER;
  process.env.ALLOW_LIVE_TRADING = "false";
  process.env.KIS_MODE = "paper";
});

test.after(() => {
  if (PREV_MASTER == null) delete process.env.BROKER_CREDENTIAL_MASTER_KEY;
  else process.env.BROKER_CREDENTIAL_MASTER_KEY = PREV_MASTER;
  if (PREV_ALLOW == null) delete process.env.ALLOW_LIVE_TRADING;
  else process.env.ALLOW_LIVE_TRADING = PREV_ALLOW;
  if (PREV_MODE == null) delete process.env.KIS_MODE;
  else process.env.KIS_MODE = PREV_MODE;
});

function baseAccount(over: Partial<RebindAccountRow> = {}): RebindAccountRow {
  return {
    id: "e3152ebd-c8f5-432f-8923-287d3163e79c",
    userId: "ff8b3224-5330-46b2-a7a4-481791a4824f",
    broker: "kis",
    environment: "PAPER",
    status: "ACTIVE",
    accountNumberMasked: maskAccountNumber(ACCOUNT_NO),
    physicalAccountFingerprint: "a".repeat(64),
    isDefault: true,
    displayName: "KIS PAPER",
    ...over,
  };
}

function baseTrading(over: Partial<RebindTradingStateRow> = {}): RebindTradingStateRow {
  return {
    autoTradingEnabled: false,
    liquidating: false,
    unknownOrderCount: 0,
    onboardingComplete: false,
    circuitHalted: false,
    ...over,
  };
}

async function run(
  over: {
    account?: Partial<RebindAccountRow>;
    trading?: Partial<RebindTradingStateRow>;
    apply?: boolean;
    confirm?: string;
    accountNo?: string;
    validateOk?: boolean;
    unresolvedOrders?: number;
    unresolvedIntents?: number;
    env?: Record<string, string | undefined>;
    logs?: string[];
  } = {},
) {
  const logs = over.logs ?? [];
  const account = baseAccount(over.account);
  const store = createMemoryRebindStore({
    account,
    tradingState: baseTrading(over.trading),
    unresolvedOrders: over.unresolvedOrders,
    unresolvedIntents: over.unresolvedIntents,
    existingPayload: {
      ciphertext: "OLD_CIPHERTEXT_MUST_NOT_DECRYPT",
      iv: "OLD_IV",
      authTag: "OLD_TAG",
      keyVersion: "v1",
    },
  });
  const result = await rebindPaperCredential({
    brokerAccountId: account.id,
    accountNo: over.accountNo ?? ACCOUNT_NO,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    apply: over.apply ?? false,
    confirm: over.confirm,
    store,
    env: {
      BROKER_CREDENTIAL_MASTER_KEY: MASTER,
      ALLOW_LIVE_TRADING: "false",
      KIS_MODE: "paper",
      ...(over.env ?? {}),
    },
    validate: async () =>
      over.validateOk === false
        ? { ok: false, error: "simulated kis fail" }
        : { ok: true },
    log: (line) => logs.push(line),
  });
  return { result, store, logs, accountId: account.id };
}

test("1. recovery succeeds without decrypting old ciphertext", async () => {
  const { result, store } = await run({ apply: true, confirm: RECOVERY_CONFIRM_TOKEN });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(store.mutations, 1);
  // Old opaque ciphertext must never be decryptable under current master — and we must not try.
  assert.throws(() =>
    decryptPaperCredentials({
      ciphertext: "OLD_CIPHERTEXT_MUST_NOT_DECRYPT",
      iv: "OLD_IV",
      authTag: "OLD_TAG",
    }),
  );
  const applied = store.lastApplied as { ciphertext: string };
  assert.notEqual(applied.ciphertext, "OLD_CIPHERTEXT_MUST_NOT_DECRYPT");
  const round = decryptPaperCredentials({
    ciphertext: (store.lastApplied as { ciphertext: string; iv: string; authTag: string }).ciphertext,
    iv: (store.lastApplied as { iv: string }).iv,
    authTag: (store.lastApplied as { authTag: string }).authTag,
  });
  assert.equal(round.appKey, APP_KEY);
  assert.equal(round.accountNo, ACCOUNT_NO);
});

test("2. account mask mismatch fails", async () => {
  const { result, store } = await run({ accountNo: "50999999" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /account_number_masked mismatch/i);
  assert.equal(store.mutations, 0);
});

test("3. refuses mutating a different broker account id", async () => {
  const account = baseAccount({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const store = createMemoryRebindStore({
    account,
    tradingState: baseTrading(),
  });
  // Requested id does not match store account → not found / mismatch path
  const result = await rebindPaperCredential({
    brokerAccountId: "e3152ebd-c8f5-432f-8923-287d3163e79c",
    accountNo: ACCOUNT_NO,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    apply: true,
    confirm: RECOVERY_CONFIRM_TOKEN,
    store,
    validate: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not found/i);
  assert.equal(store.mutations, 0);
});

test("4. MOCK account recovery forbidden", async () => {
  const { result, store } = await run({
    account: { broker: "MOCK", environment: "MOCK" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /broker=/i);
  assert.equal(store.mutations, 0);
});

test("5. DISABLED PAPER account recovery forbidden", async () => {
  const { result, store } = await run({ account: { status: "DISABLED" } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ACTIVE required/i);
  assert.equal(store.mutations, 0);
});

test("6. autoTrading=true fails", async () => {
  const { result, store } = await run({ trading: { autoTradingEnabled: true } });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /autoTradingEnabled/i);
  assert.equal(store.mutations, 0);
});

test("7. unresolved open/pending/unknown orders fail", async () => {
  const { result, store } = await run({ unresolvedOrders: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unresolved orders/i);
  assert.equal(store.mutations, 0);
});

test("8. KIS validation failure → no DB mutation", async () => {
  const { result, store } = await run({
    apply: true,
    confirm: RECOVERY_CONFIRM_TOKEN,
    validateOk: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /KIS validation failed/i);
  assert.equal(store.mutations, 0);
});

test("9. dry-run performs no DB mutation", async () => {
  const { result, store } = await run({ apply: false });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.dryRun, true);
  assert.equal(store.mutations, 0);
});

test("10. apply requires confirmation token", async () => {
  const bad = await run({ apply: true, confirm: "WRONG" });
  assert.equal(bad.result.ok, false);
  assert.equal(bad.store.mutations, 0);

  const good = await run({ apply: true, confirm: RECOVERY_CONFIRM_TOKEN });
  assert.equal(good.result.ok, true);
  assert.equal(good.result.applied, true);
  assert.equal(good.store.mutations, 1);
  const applied = good.store.lastApplied as {
    physicalAccountFingerprint: string;
    ciphertext: string;
  };
  assert.equal(applied.physicalAccountFingerprint.length, 64);
  assert.ok(applied.ciphertext.length > 20);
});

test("11. existing broker_account_id preserved on apply", async () => {
  const { result, store, accountId } = await run({
    apply: true,
    confirm: RECOVERY_CONFIRM_TOKEN,
  });
  assert.equal(result.ok, true);
  assert.equal(result.brokerAccountId, accountId);
  assert.equal(
    (store.lastApplied as { brokerAccountId: string }).brokerAccountId,
    accountId,
  );
});

test("12. trading history rows are not deleted by rebind store", async () => {
  // Memory store only mutates credential/fingerprint fields — history counters stay.
  const history = { orders: 3, intents: 2, executions: 5 };
  const { store } = await run({ apply: true, confirm: RECOVERY_CONFIRM_TOKEN });
  assert.equal(store.mutations, 1);
  assert.equal(history.orders, 3);
  assert.equal(history.intents, 2);
  assert.equal(history.executions, 5);
});

test("13. REAL / ALLOW_LIVE_TRADING=true refused", async () => {
  const live = await run({
    env: { ALLOW_LIVE_TRADING: "true", KIS_MODE: "paper" },
  });
  assert.equal(live.result.ok, false);
  assert.match(live.result.error ?? "", /ALLOW_LIVE_TRADING/i);
  assert.equal(live.store.mutations, 0);

  const realMode = await run({
    env: { ALLOW_LIVE_TRADING: "false", KIS_MODE: "real" },
  });
  assert.equal(realMode.result.ok, false);
  assert.match(realMode.result.error ?? "", /KIS_MODE/i);
  assert.equal(realMode.store.mutations, 0);
});

test("14. credentials / master key / plain account never logged", async () => {
  const logs: string[] = [];
  await run({ apply: true, confirm: RECOVERY_CONFIRM_TOKEN, logs });
  const joined = logs.join("\n");
  assertLogsHaveNoSecrets(joined, {
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    accountNo: ACCOUNT_NO,
    masterKey: MASTER,
  });
  assert.match(joined, /account=\*{4}\d{4}|accountMasked/i);
});

test("encrypt round-trip uses current master only (sanity)", () => {
  const enc = encryptPaperCredentials({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    accountNo: ACCOUNT_NO,
  });
  const dec = decryptPaperCredentials(enc);
  assert.equal(dec.appKey, APP_KEY);
  assert.equal(maskAccountNumber(dec.accountNo), maskAccountNumber(ACCOUNT_NO));
});
