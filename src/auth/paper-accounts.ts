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
import {
  findDuplicateActivePaperPhysicalAccount,
  normalizePaperAccountIdentity,
} from "@/src/runtime/paper-physical-account";

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

  await assertUniqueActivePaperPhysicalAccount(secret.accountNo);

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
}): Promise<{
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

  const existingSecret = await loadPaperSecretForAccount(input.brokerAccountId);
  const nextNo = input.accountNo.trim();
  const prevNo = existingSecret?.accountNo?.trim() ?? "";

  // Same account number (or first-time credentials on this row) → rotate in place.
  if (!prevNo || normalizeAccountNo(prevNo) === normalizeAccountNo(nextNo)) {
    await rotateCredentialsInPlace({
      userId: input.userId,
      brokerAccountId: input.brokerAccountId,
      appKey: input.appKey,
      appSecret: input.appSecret,
      accountNo: nextNo,
    });
    const { invalidateRuntimeScope, markScopeStartupSyncDone } = await import(
      "@/src/runtime/runtime-scope"
    );
    invalidateRuntimeScope(input.brokerAccountId);
    markScopeStartupSyncDone(input.brokerAccountId, false);
    await disableAutoTradingForAccount(input.brokerAccountId);
    return {
      mode: "rotate",
      brokerAccountId: input.brokerAccountId,
      note: "Same account number — credentials rotated. autoTrading OFF. Fresh Startup Sync required.",
    };
  }

  // Different account number → create new broker account; preserve old history.
  await assertAccountSwitchSafe(input.brokerAccountId);
  await disableAutoTradingForAccount(input.brokerAccountId);

  const secret: PaperCredentialSecret = {
    appKey: input.appKey.trim(),
    appSecret: input.appSecret.trim(),
    accountNo: nextNo,
  };
  const validated = await validatePaperCredentials(secret);
  if (!validated.ok) throw new Error(validated.error ?? "validation failed");

  await db
    .update(schema.brokerAccounts)
    .set({ status: "DISABLED", isDefault: false })
    .where(eq(schema.brokerAccounts.id, input.brokerAccountId));

  const created = await connectPaperAccount({
    userId: input.userId,
    alias: account.displayName || "KIS PAPER",
    accountNo: secret.accountNo,
    appKey: secret.appKey,
    appSecret: secret.appSecret,
  });

  const { invalidateRuntimeScope, markScopeStartupSyncDone } = await import(
    "@/src/runtime/runtime-scope"
  );
  invalidateRuntimeScope(input.brokerAccountId);
  markScopeStartupSyncDone(input.brokerAccountId, false);

  return {
    mode: "switch",
    brokerAccountId: created.id,
    previousBrokerAccountId: input.brokerAccountId,
    note: "Different account number — new broker account created. Old account DISABLED; history preserved.",
  };
}

function normalizeAccountNo(value: string): string {
  return normalizePaperAccountIdentity(value);
}

/**
 * Fail closed when another ACTIVE PAPER broker_account already owns this physical CANO.
 * Cross-user and same-user duplicates are both blocked.
 */
async function assertUniqueActivePaperPhysicalAccount(
  accountNo: string,
  excludeBrokerAccountId?: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.environment, "PAPER"));
  const candidates: Array<{ id: string; identity: string; status: string; environment: string }> =
    [];
  for (const row of rows) {
    if (row.status !== "ACTIVE") continue;
    const secret = await loadPaperSecretForAccount(row.id);
    candidates.push({
      id: row.id,
      identity: secret?.accountNo ?? "",
      status: row.status,
      environment: row.environment,
    });
  }
  const dup = findDuplicateActivePaperPhysicalAccount(candidates, accountNo, {
    excludeBrokerAccountId,
  });
  if (dup) {
    throw new Error(
      `ACTIVE PAPER physical account already registered (brokerAccountId=${dup}). ` +
        `Only one ACTIVE ownership is allowed per KIS PAPER CANO.`,
    );
  }
}

async function disableAutoTradingForAccount(brokerAccountId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(schema.tradingAccountState)
    .set({ autoTradingEnabled: false })
    .where(eq(schema.tradingAccountState.brokerAccountId, brokerAccountId));
  try {
    const { createTradingStateStore } = await import("@/src/runtime/trading-state-store");
    const store = createTradingStateStore({
      statePath: path.join(accountDataDir(brokerAccountId), "state.json"),
    });
    await store.mutateStore((state) => ({
      ...state,
      settings: { ...state.settings, autoTrading: false },
    }));
  } catch {
    // State file may not exist yet.
  }
}

async function assertAccountSwitchSafe(brokerAccountId: string): Promise<void> {
  try {
    const { createTradingStateStore } = await import("@/src/runtime/trading-state-store");
    const store = createTradingStateStore({
      statePath: path.join(accountDataDir(brokerAccountId), "state.json"),
    });
    const state = await store.getState();
    if (state.settings.autoTrading) {
      throw new Error("Turn off autoTrading before changing account number");
    }
    if (state.orders.some((o) => o.status === "unknown")) {
      throw new Error("UNKNOWN orders present — resolve before changing account number");
    }
    if (state.orders.some((o) => o.status === "pending")) {
      throw new Error("Pending/open orders present — resolve before changing account number");
    }
    if (state.startupSync?.status === "SYNCING") {
      throw new Error("Startup Sync is running — wait before changing account number");
    }
  } catch (err) {
    if (err instanceof Error && /autoTrading|UNKNOWN|Pending|Startup Sync/.test(err.message)) {
      throw err;
    }
    // Missing state file is OK for a fresh account.
  }
}

async function rotateCredentialsInPlace(input: {
  userId: string;
  brokerAccountId: string;
  appKey: string;
  appSecret: string;
  accountNo: string;
}): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");
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
