/**
 * Per-user preferred PAPER/REAL broker account pointers on `users`.
 * Never exposes decrypted secrets.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { AuthError } from "@/src/auth/guards";
import { loadPaperSecretForAccount } from "@/src/auth/paper-accounts";

export type UserAccountBindingView = {
  environment: "PAPER" | "REAL";
  brokerAccountId: string | null;
  accountNumberMasked: string | null;
  status: string | null;
  displayName: string | null;
  appKeyRegistered: boolean;
  appSecretRegistered: boolean;
  keyVersion: string | null;
  /** Ciphertext present and decrypts with current master key. */
  credentialsDecryptOk: boolean | null;
  /** Read-only KIS inquireBalance succeeded in a recent probe (null = not probed). */
  kisConnected: boolean | null;
  needsSelection: boolean;
  candidateCount: number;
};

async function readyDb() {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new AuthError(503, "Database unavailable");
  return db;
}

export async function listActiveEnvAccounts(userId: string, environment: "PAPER" | "REAL") {
  const db = await readyDb();
  return db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, environment),
        eq(schema.brokerAccounts.broker, "kis"),
      ),
    );
}

async function secretMeta(brokerAccountId: string): Promise<{
  registered: boolean;
  keyVersion: string | null;
  decryptOk: boolean | null;
}> {
  const db = await readyDb();
  const rows = await db
    .select()
    .from(schema.brokerSecretPayloads)
    .where(eq(schema.brokerSecretPayloads.brokerAccountId, brokerAccountId))
    .limit(1);
  const row = rows[0];
  if (!row) return { registered: false, keyVersion: null, decryptOk: null };
  try {
    await loadPaperSecretForAccount(brokerAccountId);
    return { registered: true, keyVersion: row.keyVersion, decryptOk: true };
  } catch {
    return { registered: true, keyVersion: row.keyVersion, decryptOk: false };
  }
}

export async function getUserAccountBindings(userId: string): Promise<{
  paper: UserAccountBindingView;
  real: UserAccountBindingView;
  paperBrokerAccountId: string | null;
  realBrokerAccountId: string | null;
}> {
  const db = await readyDb();
  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const user = users[0];
  if (!user) throw new AuthError(404, "User not found");

  async function build(
    environment: "PAPER" | "REAL",
    preferredId: string | null,
  ): Promise<UserAccountBindingView> {
    const active = await listActiveEnvAccounts(userId, environment);
    const needsSelection = active.length > 1 && !preferredId;
    let chosen =
      (preferredId ? active.find((a) => a.id === preferredId) : undefined) ??
      (active.length === 1 ? active[0] : undefined) ??
      (active.find((a) => a.isDefault) &&
      active.filter((a) => a.isDefault).length === 1
        ? active.find((a) => a.isDefault)
        : undefined);

    // Preferred id set but not in ACTIVE set → clear view selection.
    if (preferredId && !active.some((a) => a.id === preferredId)) {
      chosen = active.length === 1 ? active[0] : undefined;
    }

    if (!chosen) {
      return {
        environment,
        brokerAccountId: null,
        accountNumberMasked: null,
        status: null,
        displayName: null,
        appKeyRegistered: false,
        appSecretRegistered: false,
        keyVersion: null,
        credentialsDecryptOk: null,
        kisConnected: null,
        needsSelection: active.length > 1,
        candidateCount: active.length,
      };
    }

    const meta = await secretMeta(chosen.id);
    return {
      environment,
      brokerAccountId: chosen.id,
      accountNumberMasked: chosen.accountNumberMasked,
      status: chosen.status,
      displayName: chosen.displayName,
      appKeyRegistered: meta.registered,
      appSecretRegistered: meta.registered,
      keyVersion: meta.keyVersion,
      credentialsDecryptOk: meta.decryptOk,
      kisConnected: null,
      needsSelection,
      candidateCount: active.length,
    };
  }

  const paper = await build("PAPER", user.paperBrokerAccountId ?? null);
  const real = await build("REAL", user.realBrokerAccountId ?? null);
  return {
    paper,
    real,
    paperBrokerAccountId: user.paperBrokerAccountId ?? null,
    realBrokerAccountId: user.realBrokerAccountId ?? null,
  };
}

export async function setUserPreferredBrokerAccount(input: {
  userId: string;
  environment: "PAPER" | "REAL";
  brokerAccountId: string;
}): Promise<void> {
  const db = await readyDb();
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.id, input.brokerAccountId))
    .limit(1);
  const account = rows[0];
  if (!account || account.userId !== input.userId) {
    throw new Error("Broker account not owned by current user");
  }
  if (String(account.environment).toUpperCase() !== input.environment) {
    throw new Error(`Account environment must be ${input.environment}`);
  }
  if (account.status !== "ACTIVE") {
    throw new Error("Only ACTIVE accounts can be selected");
  }
  if (String(account.broker).toLowerCase() !== "kis") {
    throw new Error("Only KIS accounts can be selected");
  }

  if (input.environment === "PAPER") {
    await db
      .update(schema.users)
      .set({ paperBrokerAccountId: account.id })
      .where(eq(schema.users.id, input.userId));
    // Keep is_default aligned for PAPER trading selection compat.
    await db
      .update(schema.brokerAccounts)
      .set({ isDefault: false })
      .where(
        and(
          eq(schema.brokerAccounts.userId, input.userId),
          eq(schema.brokerAccounts.environment, "PAPER"),
          ne(schema.brokerAccounts.id, account.id),
        ),
      );
    await db
      .update(schema.brokerAccounts)
      .set({ isDefault: true, updatedAt: sql`CURRENT_TIMESTAMP(6)` })
      .where(eq(schema.brokerAccounts.id, account.id));
  } else {
    await db
      .update(schema.users)
      .set({ realBrokerAccountId: account.id })
      .where(eq(schema.users.id, input.userId));
  }
}
