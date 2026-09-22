/**
 * PAPER broker account binding for authenticated users.
 * Read-only credential validation only — never places orders.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import {
  decryptPaperCredentials,
  encryptPaperCredentials,
  maskAccountNumber,
  type PaperCredentialSecret,
} from "@/src/auth/crypto";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type ConnectedAccountView = {
  id: string;
  displayName: string;
  environment: string;
  accountNumberMasked: string | null;
  status: string;
  isDefault: boolean;
  appKeyRegistered: boolean;
  appSecretRegistered: boolean;
  dataDir: string;
};

function accountDataDir(brokerAccountId: string): string {
  return path.join(process.cwd(), "data", "accounts", brokerAccountId);
}

/** Read-only validation: token + balance. Never BUY/SELL/CANCEL. */
export async function validatePaperCredentials(secret: PaperCredentialSecret): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (String(process.env.ALLOW_LIVE_TRADING ?? "").toLowerCase() === "true") {
    return { ok: false, error: "REAL trading locked" };
  }
  const client = new KisClient(kisConfigFromPaperCredentials(secret), globalThis.fetch);
  try {
    await client.inquireBalance();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "KIS validation failed" };
  }
}

export async function listUserBrokerAccounts(userId: string): Promise<ConnectedAccountView[]> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.userId, userId));
  const out: ConnectedAccountView[] = [];
  for (const row of rows) {
    if (row.status === "DISABLED") continue;
    const secrets = await db
      .select()
      .from(schema.brokerSecretPayloads)
      .where(eq(schema.brokerSecretPayloads.brokerAccountId, row.id))
      .limit(1);
    out.push({
      id: row.id,
      displayName: row.displayName,
      environment: row.environment,
      accountNumberMasked: row.accountNumberMasked,
      status: row.status,
      isDefault: row.isDefault,
      appKeyRegistered: secrets.length > 0,
      appSecretRegistered: secrets.length > 0,
      dataDir: accountDataDir(row.id),
    });
  }
  return out;
}

export async function connectPaperAccount(input: {
  userId: string;
  alias: string;
  accountNo: string;
  appKey: string;
  appSecret: string;
}): Promise<ConnectedAccountView> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");

  // REAL accounts are locked at the API boundary.
  const secret: PaperCredentialSecret = {
    appKey: input.appKey.trim(),
    appSecret: input.appSecret.trim(),
    accountNo: input.accountNo.trim(),
  };
  const validated = await validatePaperCredentials(secret);
  if (!validated.ok) throw new Error(validated.error ?? "PAPER credential validation failed");

  const id = randomUUID();
  const enc = encryptPaperCredentials(secret);
  mkdirSync(accountDataDir(id), { recursive: true });

  await db.insert(schema.brokerAccounts).values({
    id,
    userId: input.userId,
    broker: "kis",
    environment: "PAPER",
    displayName: input.alias.trim() || "KIS PAPER",
    accountNumberMasked: maskAccountNumber(secret.accountNo),
    baseCurrency: "KRW",
    status: "ACTIVE",
    isDefault: true,
    credentialRef: `local:${id}`,
  });
  await db.insert(schema.brokerCredentialRefs).values({
    id: randomUUID(),
    brokerAccountId: id,
    secretProvider: "local_aes_gcm",
    secretRef: `broker_secret_payloads:${id}`,
    keyVersion: enc.keyVersion,
  });
  await db.insert(schema.brokerSecretPayloads).values({
    id: randomUUID(),
    brokerAccountId: id,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    keyVersion: enc.keyVersion,
  });
  await db.insert(schema.tradingAccountState).values({
    brokerAccountId: id,
    autoTradingEnabled: false,
    onboardingComplete: false,
  });

  // Mark other accounts non-default for this user.
  const others = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.userId, input.userId));
  for (const other of others) {
    if (other.id === id) continue;
    await db
      .update(schema.brokerAccounts)
      .set({ isDefault: false })
      .where(eq(schema.brokerAccounts.id, other.id));
  }

  return {
    id,
    displayName: input.alias.trim() || "KIS PAPER",
    environment: "PAPER",
    accountNumberMasked: maskAccountNumber(secret.accountNo),
    status: "ACTIVE",
    isDefault: true,
    appKeyRegistered: true,
    appSecretRegistered: true,
    dataDir: accountDataDir(id),
  };
}

export async function rotatePaperCredentials(input: {
  userId: string;
  brokerAccountId: string;
  appKey: string;
  appSecret: string;
  accountNo: string;
}): Promise<void> {
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
  const secret: PaperCredentialSecret = {
    appKey: input.appKey.trim(),
    appSecret: input.appSecret.trim(),
    accountNo: input.accountNo.trim(),
  };
  const validated = await validatePaperCredentials(secret);
  if (!validated.ok) throw new Error(validated.error ?? "validation failed");
  const enc = encryptPaperCredentials(secret);
  const existing = await db
    .select()
    .from(schema.brokerSecretPayloads)
    .where(eq(schema.brokerSecretPayloads.brokerAccountId, input.brokerAccountId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(schema.brokerSecretPayloads)
      .set({
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion,
      })
      .where(eq(schema.brokerSecretPayloads.brokerAccountId, input.brokerAccountId));
  } else {
    await db.insert(schema.brokerSecretPayloads).values({
      id: randomUUID(),
      brokerAccountId: input.brokerAccountId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
    });
  }
  await db
    .update(schema.brokerAccounts)
    .set({ accountNumberMasked: maskAccountNumber(secret.accountNo) })
    .where(eq(schema.brokerAccounts.id, input.brokerAccountId));
  await db
    .update(schema.tradingAccountState)
    .set({ autoTradingEnabled: false })
    .where(eq(schema.tradingAccountState.brokerAccountId, input.brokerAccountId));
}

export async function loadPaperSecretForAccount(
  brokerAccountId: string,
): Promise<PaperCredentialSecret | null> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(schema.brokerSecretPayloads)
    .where(eq(schema.brokerSecretPayloads.brokerAccountId, brokerAccountId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return decryptPaperCredentials(row);
}

export { accountDataDir };
