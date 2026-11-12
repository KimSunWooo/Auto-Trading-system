/**
 * REAL broker account binding for authenticated users.
 * Read-only credential validation + storage only — never places orders / auto-trades.
 * REAL order/autotrading locks remain enforced elsewhere.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import {
  encryptPaperCredentials,
  maskAccountNumber,
  realPhysicalAccountFingerprint,
  type PaperCredentialSecret,
} from "@/src/auth/crypto";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromRealCredentials } from "@/src/brokers/kis-config";
import { mkdirSync } from "node:fs";
import { normalizePaperAccountIdentity } from "@/src/runtime/paper-account-identity";
import type { ConnectedAccountView, ConnectPaperAccountOpts } from "@/src/auth/paper-accounts";
import { accountDataDir, loadPaperSecretForAccount } from "@/src/auth/paper-accounts";

const ACTIVE_REAL_PHYSICAL_ALREADY_REGISTERED =
  "This REAL KIS account is already registered to another user";

export type ConnectRealAccountOpts = ConnectPaperAccountOpts;

/** Read-only validation on REAL host. Never BUY/SELL/CANCEL; liveEnabled is false. */
export async function validateRealCredentials(secret: PaperCredentialSecret): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (String(process.env.ALLOW_LIVE_TRADING ?? "").toLowerCase() === "true") {
    return { ok: false, error: "REAL trading locked — unset ALLOW_LIVE_TRADING to register" };
  }
  const cfg = kisConfigFromRealCredentials(secret);
  if (cfg.liveEnabled) {
    return { ok: false, error: "REAL live trading must stay locked during registration" };
  }
  const client = new KisClient(cfg, globalThis.fetch);
  try {
    await client.inquireBalance();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "KIS REAL validation failed" };
  }
}

async function assertUniqueActiveRealPhysicalAccount(
  accountNo: string,
  excludeBrokerAccountId?: string,
  nextFingerprint?: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const fingerprint = nextFingerprint ?? realPhysicalAccountFingerprint(accountNo);
  const byFp = await db
    .select({ id: schema.brokerAccounts.id })
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.environment, "REAL"),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.physicalAccountFingerprint, fingerprint),
      ),
    )
    .limit(1);
  if (byFp[0] && byFp[0].id !== excludeBrokerAccountId) {
    throw new Error(ACTIVE_REAL_PHYSICAL_ALREADY_REGISTERED);
  }
}

export async function connectRealAccount(
  input: {
    userId: string;
    alias: string;
    accountNo: string;
    appKey: string;
    appSecret: string;
  },
  opts: ConnectRealAccountOpts = {},
): Promise<ConnectedAccountView> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");

  const secret: PaperCredentialSecret = {
    appKey: input.appKey.trim(),
    appSecret: input.appSecret.trim(),
    accountNo: input.accountNo.trim(),
  };
  if (!opts.skipLiveValidation) {
    const validated = await validateRealCredentials(secret);
    if (!validated.ok) throw new Error(validated.error ?? "REAL credential validation failed");
  }

  const fingerprint = realPhysicalAccountFingerprint(secret.accountNo);
  await assertUniqueActiveRealPhysicalAccount(secret.accountNo, undefined, fingerprint);

  const id = randomUUID();
  const enc = encryptPaperCredentials(secret);
  mkdirSync(accountDataDir(id), { recursive: true });

  await db.transaction(async (tx) => {
    await tx.insert(schema.brokerAccounts).values({
      id,
      userId: input.userId,
      broker: "kis",
      environment: "REAL",
      displayName: input.alias.trim() || "KIS REAL",
      accountNumberMasked: maskAccountNumber(secret.accountNo),
      baseCurrency: "KRW",
      status: "ACTIVE",
      // REAL never becomes the trading default — PAPER remains the order path.
      isDefault: false,
      credentialRef: `local:${id}`,
      physicalAccountFingerprint: fingerprint,
    });
    await tx.insert(schema.brokerCredentialRefs).values({
      id: randomUUID(),
      brokerAccountId: id,
      secretProvider: "local_aes_gcm",
      secretRef: `broker_secret_payloads:${id}`,
      keyVersion: enc.keyVersion,
    });
    await tx.insert(schema.brokerSecretPayloads).values({
      id: randomUUID(),
      brokerAccountId: id,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
    });
    await tx.insert(schema.tradingAccountState).values({
      brokerAccountId: id,
      autoTradingEnabled: false,
      onboardingComplete: false,
    });
  });

  return {
    id,
    displayName: input.alias.trim() || "KIS REAL",
    environment: "REAL",
    accountNumberMasked: maskAccountNumber(secret.accountNo),
    status: "ACTIVE",
    isDefault: false,
    appKeyRegistered: true,
    appSecretRegistered: true,
    dataDir: accountDataDir(id),
  };
}

export async function rotateRealCredentials(
  input: {
    userId: string;
    brokerAccountId: string;
    appKey: string;
    appSecret: string;
    accountNo: string;
  },
  opts: ConnectRealAccountOpts = {},
): Promise<{
  mode: "rotate" | "switch";
  brokerAccountId: string;
  previousBrokerAccountId?: string;
  note: string;
}> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");

  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.id, input.brokerAccountId))
    .limit(1);
  const account = rows[0];
  if (!account || account.userId !== input.userId) {
    throw new Error("Broker account not owned by current user");
  }
  if (String(account.environment).toUpperCase() !== "REAL") {
    throw new Error("Not a REAL broker account");
  }

  const existingSecret = await loadPaperSecretForAccount(input.brokerAccountId);
  const nextNo = input.accountNo.trim();
  const prevNo = existingSecret?.accountNo?.trim() ?? "";
  const same =
    !prevNo ||
    normalizePaperAccountIdentity(prevNo) === normalizePaperAccountIdentity(nextNo);

  const secret: PaperCredentialSecret = {
    appKey: input.appKey.trim(),
    appSecret: input.appSecret.trim(),
    accountNo: nextNo,
  };
  if (!opts.skipLiveValidation) {
    const validated = await validateRealCredentials(secret);
    if (!validated.ok) throw new Error(validated.error ?? "validation failed");
  }

  if (same) {
    const enc = encryptPaperCredentials(secret);
    const fingerprint = realPhysicalAccountFingerprint(secret.accountNo);
    await assertUniqueActiveRealPhysicalAccount(secret.accountNo, input.brokerAccountId, fingerprint);
    const existing = await db
      .select()
      .from(schema.brokerSecretPayloads)
      .where(eq(schema.brokerSecretPayloads.brokerAccountId, input.brokerAccountId))
      .limit(1);
    await db.transaction(async (tx) => {
      if (existing[0]) {
        await tx
          .update(schema.brokerSecretPayloads)
          .set({
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            authTag: enc.authTag,
            keyVersion: enc.keyVersion,
          })
          .where(eq(schema.brokerSecretPayloads.brokerAccountId, input.brokerAccountId));
      } else {
        await tx.insert(schema.brokerSecretPayloads).values({
          id: randomUUID(),
          brokerAccountId: input.brokerAccountId,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          keyVersion: enc.keyVersion,
        });
      }
      await tx
        .update(schema.brokerAccounts)
        .set({
          accountNumberMasked: maskAccountNumber(secret.accountNo),
          physicalAccountFingerprint: fingerprint,
          status: "ACTIVE",
        })
        .where(eq(schema.brokerAccounts.id, input.brokerAccountId));
    });
    return {
      mode: "rotate",
      brokerAccountId: input.brokerAccountId,
      note: "REAL credentials rotated (read-only). Orders remain locked.",
    };
  }

  // Different account number → new REAL row; preserve old history as DISABLED.
  await db
    .update(schema.brokerAccounts)
    .set({
      status: "DISABLED",
      isDefault: false,
      physicalAccountFingerprint: null,
    })
    .where(eq(schema.brokerAccounts.id, input.brokerAccountId));

  const created = await connectRealAccount(
    {
      userId: input.userId,
      alias: account.displayName || "KIS REAL",
      accountNo: secret.accountNo,
      appKey: secret.appKey,
      appSecret: secret.appSecret,
    },
    { skipLiveValidation: true },
  );

  return {
    mode: "switch",
    brokerAccountId: created.id,
    previousBrokerAccountId: input.brokerAccountId,
    note: "Different REAL account number — new row created. Old REAL account DISABLED; history preserved.",
  };
}

/** Decrypt secret for a user-owned REAL account only. */
export async function loadRealSecretForUserAccount(
  userId: string,
  brokerAccountId: string,
): Promise<PaperCredentialSecret | null> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.id, brokerAccountId),
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.environment, "REAL"),
      ),
    )
    .limit(1);
  if (!rows[0] || rows[0].status === "DISABLED") return null;
  const secret = await loadPaperSecretForAccount(brokerAccountId);
  return secret;
}

export { ACTIVE_REAL_PHYSICAL_ALREADY_REGISTERED };
