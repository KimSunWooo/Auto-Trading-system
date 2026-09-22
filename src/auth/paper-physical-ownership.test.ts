/**
 * D1–D10: PAPER physical account ownership — DB unique fingerprint authority.
 * Requires DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY (live RDS or local).
 * Never places KIS orders (skipLiveValidation).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import test from "node:test";
import {
  connectPaperAccount,
  rotatePaperCredentials,
} from "@/src/auth/paper-accounts";
import {
  paperPhysicalAccountFingerprint,
} from "@/src/auth/crypto";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { getDb, resetDbClientForTest } from "@/src/db/client";
import { loadLocalEnv } from "@/src/db/load-env";
import * as schema from "@/src/db/schema";
import {
  ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED,
  sanitizePaperPhysicalOwnershipError,
} from "@/src/runtime/paper-physical-account";

loadLocalEnv();

const hasDb = Boolean(process.env.DATABASE_URL || process.env.AWS_RDS_HOST);
const hasMaster = Boolean(process.env.BROKER_CREDENTIAL_MASTER_KEY?.trim());
const live = hasDb && hasMaster;

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

async function createTestUser(label: string): Promise<string> {
  const db = getDb();
  assert.ok(db);
  const id = randomUUID();
  const email = `phys-own-${label}-${id.slice(0, 8)}@example.test`;
  await db.insert(schema.users).values({
    id,
    email,
    displayName: `phys-test-${label}`,
    role: "USER",
    status: "ACTIVE",
  });
  createdUserIds.push(id);
  return id;
}

function trackAccount(id: string): string {
  createdAccountIds.push(id);
  return id;
}

async function countActiveByFingerprint(fp: string): Promise<number> {
  const db = getDb();
  assert.ok(db);
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.physicalAccountFingerprint, fp));
  return rows.filter((r) => r.status === "ACTIVE").length;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  if (!db) return;
  if (createdAccountIds.length) {
    await db
      .delete(schema.tradingAccountState)
      .where(inArray(schema.tradingAccountState.brokerAccountId, createdAccountIds));
    await db
      .delete(schema.brokerSecretPayloads)
      .where(inArray(schema.brokerSecretPayloads.brokerAccountId, createdAccountIds));
    await db
      .delete(schema.brokerCredentialRefs)
      .where(inArray(schema.brokerCredentialRefs.brokerAccountId, createdAccountIds));
    await db
      .delete(schema.brokerAccounts)
      .where(inArray(schema.brokerAccounts.id, createdAccountIds));
    for (const id of createdAccountIds) {
      try {
        rmSync(`data/accounts/${id}`, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    createdAccountIds.length = 0;
  }
  if (createdUserIds.length) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    createdUserIds.length = 0;
  }
}

test.before(async () => {
  if (!live) return;
  process.env.ALLOW_LIVE_TRADING = "false";
  resetDbClientForTest();
  await ensureAuthSchema();
});

test.after(async () => {
  if (!live) return;
  await cleanup();
  resetDbClientForTest();
});

test("fingerprint helper: deterministic HMAC, no plaintext dependence in output shape", () => {
  if (!hasMaster) {
    process.env.BROKER_CREDENTIAL_MASTER_KEY = "unit-test-master-key-32chars-min!!";
  }
  const a = paperPhysicalAccountFingerprint("5012-3456-01");
  const b = paperPhysicalAccountFingerprint("5012345601");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.equal(/^[0-9a-f]+$/.test(a), true);
  assert.notEqual(a, paperPhysicalAccountFingerprint("50999999-01"));
});

test("D9 duplicate-key DB exception → sanitized application error", () => {
  const raw = Object.assign(new Error("Duplicate entry 'kis-PAPER-abc' for key 'uq_broker_accounts_paper_physical'"), {
    errno: 1062,
    code: "ER_DUP_ENTRY",
  });
  const sanitized = sanitizePaperPhysicalOwnershipError(raw);
  assert.equal(sanitized.message, ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED);
  assert.equal(sanitized.message.includes("Duplicate entry"), false);
});

test("D1 sequential duplicate → second rejected; ACTIVE owners = 1", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d1");
  const accountNo = `88${Date.now().toString().slice(-6)}01`;
  const fp = paperPhysicalAccountFingerprint(accountNo);

  const first = await connectPaperAccount(
    {
      userId: user,
      alias: "D1-A",
      accountNo,
      appKey: "test-app-key-aaaaaaaa",
      appSecret: "test-app-secret-bbbbbbbb",
    },
    { skipLiveValidation: true },
  );
  trackAccount(first.id);

  await assert.rejects(
    () =>
      connectPaperAccount(
        {
          userId: user,
          alias: "D1-B",
          accountNo,
          appKey: "test-app-key-cccccccc",
          appSecret: "test-app-secret-dddddddd",
        },
        { skipLiveValidation: true },
      ),
    (err: unknown) =>
      err instanceof Error && err.message.includes(ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED),
  );

  assert.equal(await countActiveByFingerprint(fp), 1);
});

test("D2 concurrent same account connect → exactly one succeeds", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const userA = await createTestUser("d2a");
  const userB = await createTestUser("d2b");
  const accountNo = `77${Date.now().toString().slice(-6)}02`;
  const fp = paperPhysicalAccountFingerprint(accountNo);

  const results = await Promise.allSettled([
    connectPaperAccount(
      {
        userId: userA,
        alias: "D2-A",
        accountNo,
        appKey: "test-app-key-eeeeeeee",
        appSecret: "test-app-secret-ffffffff",
      },
      { skipLiveValidation: true },
    ),
    connectPaperAccount(
      {
        userId: userB,
        alias: "D2-B",
        accountNo,
        appKey: "test-app-key-gggggggg",
        appSecret: "test-app-secret-hhhhhhhh",
      },
      { skipLiveValidation: true },
    ),
  ]);

  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, `expected 1 success, got ${ok.length}`);
  assert.equal(bad.length, 1, `expected 1 reject, got ${bad.length}`);
  if (ok[0]?.status === "fulfilled") trackAccount(ok[0].value.id);
  if (bad[0]?.status === "rejected") {
    const msg = bad[0].reason instanceof Error ? bad[0].reason.message : String(bad[0].reason);
    assert.match(msg, /ACTIVE PAPER physical account already registered/);
    assert.equal(msg.includes("Duplicate entry"), false);
  }
  assert.equal(await countActiveByFingerprint(fp), 1);
});

test("D3 cross-user same physical account → second rejected", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const userA = await createTestUser("d3a");
  const userB = await createTestUser("d3b");
  const accountNo = `66${Date.now().toString().slice(-6)}03`;
  const a = await connectPaperAccount(
    {
      userId: userA,
      alias: "D3-A",
      accountNo,
      appKey: "test-app-key-iiiiiiii",
      appSecret: "test-app-secret-jjjjjjjj",
    },
    { skipLiveValidation: true },
  );
  trackAccount(a.id);
  await assert.rejects(
    () =>
      connectPaperAccount(
        {
          userId: userB,
          alias: "D3-B",
          accountNo,
          appKey: "test-app-key-kkkkkkkk",
          appSecret: "test-app-secret-llllllll",
        },
        { skipLiveValidation: true },
      ),
    (err: unknown) =>
      err instanceof Error && err.message.includes(ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED),
  );
});

test("D4 same user same physical account → second rejected", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d4");
  const accountNo = `55${Date.now().toString().slice(-6)}04`;
  const a = await connectPaperAccount(
    {
      userId: user,
      alias: "D4-A",
      accountNo,
      appKey: "test-app-key-mmmmmmmm",
      appSecret: "test-app-secret-nnnnnnnn",
    },
    { skipLiveValidation: true },
  );
  trackAccount(a.id);
  await assert.rejects(
    () =>
      connectPaperAccount(
        {
          userId: user,
          alias: "D4-B",
          accountNo,
          appKey: "test-app-key-oooooooo",
          appSecret: "test-app-secret-pppppppp",
        },
        { skipLiveValidation: true },
      ),
    (err: unknown) =>
      err instanceof Error && err.message.includes(ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED),
  );
});

test("D5 different physical accounts → both succeed", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d5");
  const stamp = Date.now().toString().slice(-6);
  const a = await connectPaperAccount(
    {
      userId: user,
      alias: "D5-A",
      accountNo: `44${stamp}05`,
      appKey: "test-app-key-qqqqqqqq",
      appSecret: "test-app-secret-rrrrrrrr",
    },
    { skipLiveValidation: true },
  );
  trackAccount(a.id);
  const b = await connectPaperAccount(
    {
      userId: user,
      alias: "D5-B",
      accountNo: `44${stamp}15`,
      appKey: "test-app-key-ssssssss",
      appSecret: "test-app-secret-tttttttt",
    },
    { skipLiveValidation: true },
  );
  trackAccount(b.id);
  assert.notEqual(a.id, b.id);
});

test("D6 DISABLED historical does not block future ownership after claim release", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d6");
  const accountNo = `33${Date.now().toString().slice(-6)}06`;
  const first = await connectPaperAccount(
    {
      userId: user,
      alias: "D6-old",
      accountNo,
      appKey: "test-app-key-uuuuuuuu",
      appSecret: "test-app-secret-vvvvvvvv",
    },
    { skipLiveValidation: true },
  );
  trackAccount(first.id);

  const switched = await rotatePaperCredentials(
    {
      userId: user,
      brokerAccountId: first.id,
      appKey: "test-app-key-wwwwwwww",
      appSecret: "test-app-secret-xxxxxxxx",
      accountNo: `33${Date.now().toString().slice(-5)}16`,
    },
    { skipLiveValidation: true },
  );
  trackAccount(switched.brokerAccountId);
  assert.equal(switched.mode, "switch");

  const db = getDb()!;
  const oldRows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.id, first.id));
  assert.equal(oldRows[0]?.status, "DISABLED");
  assert.equal(oldRows[0]?.physicalAccountFingerprint, null);

  // Reclaim original physical account under a new user after claim release.
  const user2 = await createTestUser("d6b");
  const reclaim = await connectPaperAccount(
    {
      userId: user2,
      alias: "D6-reclaim",
      accountNo,
      appKey: "test-app-key-yyyyyyyy",
      appSecret: "test-app-secret-zzzzzzzz",
    },
    { skipLiveValidation: true },
  );
  trackAccount(reclaim.id);
  assert.equal(await countActiveByFingerprint(paperPhysicalAccountFingerprint(accountNo)), 1);
});

test("D7 credential rotation same account → no duplicate ownership", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d7");
  const accountNo = `22${Date.now().toString().slice(-6)}07`;
  const first = await connectPaperAccount(
    {
      userId: user,
      alias: "D7",
      accountNo,
      appKey: "test-app-key-11111111",
      appSecret: "test-app-secret-22222222",
    },
    { skipLiveValidation: true },
  );
  trackAccount(first.id);
  const fp = paperPhysicalAccountFingerprint(accountNo);

  const rotated = await rotatePaperCredentials(
    {
      userId: user,
      brokerAccountId: first.id,
      appKey: "test-app-key-33333333",
      appSecret: "test-app-secret-44444444",
      accountNo: accountNo.replace(/(\d{2})$/, "-$1"), // same digits, dashed
    },
    { skipLiveValidation: true },
  );
  assert.equal(rotated.mode, "rotate");
  assert.equal(rotated.brokerAccountId, first.id);
  assert.equal(await countActiveByFingerprint(fp), 1);
});

test("D8 different account switch → old DISABLED/fingerprint released, new claimed", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d8");
  const oldNo = `11${Date.now().toString().slice(-6)}08`;
  const newNo = `11${Date.now().toString().slice(-6)}18`;
  const first = await connectPaperAccount(
    {
      userId: user,
      alias: "D8",
      accountNo: oldNo,
      appKey: "test-app-key-55555555",
      appSecret: "test-app-secret-66666666",
    },
    { skipLiveValidation: true },
  );
  trackAccount(first.id);

  const switched = await rotatePaperCredentials(
    {
      userId: user,
      brokerAccountId: first.id,
      appKey: "test-app-key-77777777",
      appSecret: "test-app-secret-88888888",
      accountNo: newNo,
    },
    { skipLiveValidation: true },
  );
  trackAccount(switched.brokerAccountId);
  assert.equal(switched.mode, "switch");
  assert.notEqual(switched.brokerAccountId, first.id);

  const db = getDb()!;
  const oldRow = (
    await db.select().from(schema.brokerAccounts).where(eq(schema.brokerAccounts.id, first.id))
  )[0]!;
  const newRow = (
    await db
      .select()
      .from(schema.brokerAccounts)
      .where(eq(schema.brokerAccounts.id, switched.brokerAccountId))
  )[0]!;
  assert.equal(oldRow.status, "DISABLED");
  assert.equal(oldRow.physicalAccountFingerprint, null);
  assert.equal(newRow.status, "ACTIVE");
  assert.equal(newRow.physicalAccountFingerprint, paperPhysicalAccountFingerprint(newNo));
});

test("D10 no plaintext account number or HMAC key logged during connect", async (t) => {
  if (!live) return t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
  await cleanup();
  const user = await createTestUser("d10");
  const accountNo = `99${Date.now().toString().slice(-6)}10`;
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const created = await connectPaperAccount(
      {
        userId: user,
        alias: "D10",
        accountNo,
        appKey: "test-app-key-d10d10d10",
        appSecret: "test-app-secret-d10d10d10",
      },
      { skipLiveValidation: true },
    );
    trackAccount(created.id);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
  const joined = logs.join("\n");
  assert.equal(joined.includes(accountNo), false);
  assert.equal(joined.includes(normalizeDigits(accountNo)), false);
  assert.equal(joined.includes(String(process.env.BROKER_CREDENTIAL_MASTER_KEY ?? "")), false);
});

function normalizeDigits(v: string): string {
  return v.replace(/[\s-]/g, "");
}
