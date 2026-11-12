/**
 * Strict PAPER account selection for logged-in users.
 * Prefers users.paper_broker_account_id when set and valid.
 * Never pick an arbitrary ACTIVE row when defaults are ambiguous.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { AuthError } from "@/src/auth/guards";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";

export class PaperAccountSelectionError extends Error {
  readonly code:
    | "ACCOUNT_SELECTION_REQUIRED"
    | "MULTIPLE_DEFAULT_ACCOUNTS"
    | "ACCOUNT_NOT_CONNECTED"
    | "ACCOUNT_FINGERPRINT_MISSING";
  constructor(
    code:
      | "ACCOUNT_SELECTION_REQUIRED"
      | "MULTIPLE_DEFAULT_ACCOUNTS"
      | "ACCOUNT_NOT_CONNECTED"
      | "ACCOUNT_FINGERPRINT_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "PaperAccountSelectionError";
    this.code = code;
  }
}

export type SelectedPaperAccount = typeof schema.brokerAccounts.$inferSelect;

/**
 * Resolve the unique ACTIVE PAPER account for a user.
 *
 * Rules:
 * - users.paper_broker_account_id points at owned ACTIVE PAPER → use it
 * - else default ACTIVE PAPER exactly 1 → use it
 * - default 0 + ACTIVE exactly 1 → use it (compat)
 * - default 0 + ACTIVE 2+ → ACCOUNT_SELECTION_REQUIRED
 * - default 2+ → MULTIPLE_DEFAULT_ACCOUNTS
 * - ACTIVE PAPER without fingerprint → ACCOUNT_FINGERPRINT_MISSING
 */
export async function selectOwnedPaperAccount(userId: string): Promise<SelectedPaperAccount> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new AuthError(503, "Database unavailable");

  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const preferredId = users[0]?.paperBrokerAccountId ?? null;

  const active = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
        eq(schema.brokerAccounts.broker, "kis"),
      ),
    );

  if (active.length === 0) {
    throw new PaperAccountSelectionError(
      "ACCOUNT_NOT_CONNECTED",
      "PAPER broker account is not connected",
    );
  }

  if (preferredId) {
    const preferred = active.find((row) => row.id === preferredId);
    if (preferred) {
      if (!preferred.physicalAccountFingerprint) {
        throw new PaperAccountSelectionError(
          "ACCOUNT_FINGERPRINT_MISSING",
          "ACTIVE PAPER account is missing physicalAccountFingerprint",
        );
      }
      return preferred;
    }
  }

  const defaults = active.filter((row) => row.isDefault);
  if (defaults.length > 1) {
    throw new PaperAccountSelectionError(
      "MULTIPLE_DEFAULT_ACCOUNTS",
      "Multiple default ACTIVE PAPER accounts — selection required",
    );
  }
  if (defaults.length === 0 && active.length > 1) {
    throw new PaperAccountSelectionError(
      "ACCOUNT_SELECTION_REQUIRED",
      "Multiple ACTIVE PAPER accounts without default — selection required",
    );
  }

  const selected = defaults[0] ?? active[0]!;
  if (!selected.physicalAccountFingerprint) {
    throw new PaperAccountSelectionError(
      "ACCOUNT_FINGERPRINT_MISSING",
      "ACTIVE PAPER account is missing physicalAccountFingerprint",
    );
  }
  return selected;
}

/** Compatibility wrapper used by resolve-trading-runtime. */
export async function findDefaultPaperAccount(userId: string): Promise<SelectedPaperAccount | null> {
  try {
    return await selectOwnedPaperAccount(userId);
  } catch (err) {
    if (err instanceof PaperAccountSelectionError && err.code === "ACCOUNT_NOT_CONNECTED") {
      return null;
    }
    throw err;
  }
}

/** Self-heal: when exactly one ACTIVE PAPER exists and isDefault=false, mark it default + preference. */
export async function maybeSelfHealSinglePaperDefault(userId: string): Promise<void> {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) return;
  const active = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
        eq(schema.brokerAccounts.broker, "kis"),
      ),
    );
  if (active.length !== 1) return;
  const row = active[0]!;
  if (!row.isDefault) {
    await db
      .update(schema.brokerAccounts)
      .set({ isDefault: true, updatedAt: sql`CURRENT_TIMESTAMP(6)` })
      .where(eq(schema.brokerAccounts.id, row.id));
  }
  await db
    .update(schema.users)
    .set({ paperBrokerAccountId: row.id })
    .where(and(eq(schema.users.id, userId), sql`paper_broker_account_id IS NULL`));
}
