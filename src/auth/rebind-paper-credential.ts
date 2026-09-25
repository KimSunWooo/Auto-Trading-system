/**
 * Operator-only PAPER credential rebind after BROKER_CREDENTIAL_MASTER_KEY loss.
 *
 * Isolated from rotatePaperCredentials / connectPaperAccount:
 * - NEVER decrypts existing broker_secret_payloads ciphertext
 * - NEVER places orders
 * - NEVER enables autoTrading
 * - Preserves broker_accounts.id and all broker_account_id history
 *
 * CLI: scripts/rebind-paper-credential.ts (npm run credentials:rebind-paper)
 */
import { and, eq, inArray } from "drizzle-orm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  decryptPaperCredentials,
  encryptPaperCredentials,
  maskAccountNumber,
  paperPhysicalAccountFingerprint,
  type PaperCredentialSecret,
} from "@/src/auth/crypto";
import { validatePaperCredentials } from "@/src/auth/paper-accounts";
import { getDb, type AppDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { normalizePaperAccountIdentity } from "@/src/runtime/paper-account-identity";
import { emptyStartupSync } from "@/src/runtime/startup-sync";
import {
  invalidateRuntimeScope,
  markScopeStartupSyncDone,
} from "@/src/runtime/runtime-scope";

/** Must match exactly for RECOVERY_APPLY=true mutations. */
export const RECOVERY_CONFIRM_TOKEN = "REBINDS_EXISTING_PAPER_CREDENTIAL";

/** DB + runtime statuses that mean an order lifecycle is not terminal. */
export const UNRESOLVED_ORDER_STATUSES = [
  "UNKNOWN",
  "PENDING",
  "SUBMITTED",
  "ACCEPTED",
  "OPEN",
  "PARTIALLY_FILLED",
  "WORKING",
  "unknown",
  "pending",
  "submitted",
  "accepted",
  "open",
  "partially_filled",
  "working",
] as const;

export const UNRESOLVED_INTENT_STATUSES = [
  "UNKNOWN",
  "PENDING",
  "SUBMITTED",
  "ACCEPTED",
  "OPEN",
  "unknown",
  "pending",
  "submitted",
  "accepted",
  "open",
] as const;

export type RebindPaperCredentialParams = {
  brokerAccountId: string;
  accountNo: string;
  appKey: string;
  appSecret: string;
  /** Default false — dry-run only. */
  apply?: boolean;
  confirm?: string;
  /** Injected for tests. Defaults to process.env checks. */
  env?: Record<string, string | undefined>;
  /** Injected for tests. Defaults to live validatePaperCredentials. */
  validate?: typeof validatePaperCredentials;
  store?: RebindPaperCredentialStore;
  /** Captured log lines (never secrets). */
  log?: (line: string) => void;
};

export type RebindAccountRow = {
  id: string;
  userId: string;
  broker: string;
  environment: string;
  status: string;
  accountNumberMasked: string | null;
  physicalAccountFingerprint: string | null;
  isDefault: boolean;
  displayName: string;
};

export type RebindTradingStateRow = {
  autoTradingEnabled: boolean;
  liquidating: boolean;
  unknownOrderCount: number;
  onboardingComplete: boolean;
  circuitHalted: boolean;
};

export type RebindPaperCredentialStore = {
  loadAccount(id: string): Promise<RebindAccountRow | null>;
  countSecretPayloads(id: string): Promise<number>;
  countCredentialRefs(id: string): Promise<number>;
  loadTradingState(id: string): Promise<RebindTradingStateRow | null>;
  countUnresolvedOrders(id: string): Promise<number>;
  countUnresolvedIntents(id: string): Promise<number>;
  /**
   * Apply encrypted payload + fingerprint update for THIS broker account only.
   * Must not insert a new broker_accounts row or change id/user_id.
   */
  applyCredentialRebind(input: {
    brokerAccountId: string;
    accountNumberMasked: string;
    physicalAccountFingerprint: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: string;
  }): Promise<void>;
  /** Post-apply: load ciphertext for round-trip verify (new master key only). */
  loadSecretPayload(id: string): Promise<{
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: string;
  } | null>;
};

export type RebindPaperCredentialResult = {
  ok: boolean;
  applied: boolean;
  dryRun: boolean;
  brokerAccountId: string;
  accountMasked: string;
  autoTradingOff: boolean;
  startupSyncRequired: boolean;
  kisValidationOk: boolean;
  error?: string;
  checks: string[];
};

function truthyApply(raw: unknown): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true";
}

function assertEnvSafeForRecovery(env: Record<string, string | undefined>): void {
  if (String(env.ALLOW_LIVE_TRADING ?? "").trim().toLowerCase() === "true") {
    throw new Error("RECOVERY_REFUSED: ALLOW_LIVE_TRADING=true");
  }
  const mode = String(env.KIS_MODE ?? "paper").trim().toLowerCase();
  if (mode && mode !== "paper" && mode !== "demo") {
    throw new Error(`RECOVERY_REFUSED: KIS_MODE=${mode} (PAPER required)`);
  }
  // REAL credential slots must not drive recovery validation.
  if (String(env.KIS_LIVE_CONFIRM ?? "").trim() === "I_UNDERSTAND") {
    throw new Error("RECOVERY_REFUSED: KIS_LIVE_CONFIRM set (REAL unlock path)");
  }
}

function requireMasterKey(env: Record<string, string | undefined>): void {
  const raw = env.BROKER_CREDENTIAL_MASTER_KEY?.trim() ?? "";
  if (raw.length < 32) {
    throw new Error("BROKER_CREDENTIAL_MASTER_KEY must be set (>=32 chars)");
  }
}

function secretsEqual(a: PaperCredentialSecret, b: PaperCredentialSecret): boolean {
  return (
    a.appKey === b.appKey &&
    a.appSecret === b.appSecret &&
    normalizePaperAccountIdentity(a.accountNo) === normalizePaperAccountIdentity(b.accountNo)
  );
}

/** In-memory store for unit tests — never touches RDS. */
export function createMemoryRebindStore(seed: {
  account: RebindAccountRow;
  tradingState: RebindTradingStateRow;
  secretPayloads?: number;
  credentialRefs?: number;
  unresolvedOrders?: number;
  unresolvedIntents?: number;
  /** Opaque existing ciphertext (must never be decrypted by recovery). */
  existingPayload?: {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: string;
  };
}): RebindPaperCredentialStore & {
  mutations: number;
  lastApplied: unknown;
  decryptAttemptsOnExisting: number;
} {
  let payloadCount = seed.secretPayloads ?? 1;
  let refCount = seed.credentialRefs ?? 1;
  let payload = seed.existingPayload
    ? { ...seed.existingPayload }
    : {
        ciphertext: "OLD_CIPHERTEXT_MUST_NOT_DECRYPT",
        iv: "OLD_IV",
        authTag: "OLD_TAG",
        keyVersion: "v1",
      };
  const state = {
    mutations: 0,
    lastApplied: null as unknown,
    decryptAttemptsOnExisting: 0,
  };
  const store: RebindPaperCredentialStore & typeof state = {
    ...state,
    async loadAccount(id) {
      return id === seed.account.id ? { ...seed.account } : null;
    },
    async countSecretPayloads(id) {
      return id === seed.account.id ? payloadCount : 0;
    },
    async countCredentialRefs(id) {
      return id === seed.account.id ? refCount : 0;
    },
    async loadTradingState(id) {
      return id === seed.account.id ? { ...seed.tradingState } : null;
    },
    async countUnresolvedOrders(id) {
      return id === seed.account.id ? (seed.unresolvedOrders ?? 0) : 0;
    },
    async countUnresolvedIntents(id) {
      return id === seed.account.id ? (seed.unresolvedIntents ?? 0) : 0;
    },
    async applyCredentialRebind(input) {
      if (input.brokerAccountId !== seed.account.id) {
        throw new Error("memory store refused foreign broker account id");
      }
      store.mutations += 1;
      store.lastApplied = { ...input };
      payload = {
        ciphertext: input.ciphertext,
        iv: input.iv,
        authTag: input.authTag,
        keyVersion: input.keyVersion,
      };
      seed.account.accountNumberMasked = input.accountNumberMasked;
      seed.account.physicalAccountFingerprint = input.physicalAccountFingerprint;
      payloadCount = 1;
      refCount = 1;
    },
    async loadSecretPayload(id) {
      if (id !== seed.account.id) return null;
      return { ...payload };
    },
  };
  return store;
}

export function createMysqlRebindStore(db: AppDb): RebindPaperCredentialStore {
  return {
    async loadAccount(id) {
      const rows = await db
        .select({
          id: schema.brokerAccounts.id,
          userId: schema.brokerAccounts.userId,
          broker: schema.brokerAccounts.broker,
          environment: schema.brokerAccounts.environment,
          status: schema.brokerAccounts.status,
          accountNumberMasked: schema.brokerAccounts.accountNumberMasked,
          physicalAccountFingerprint: schema.brokerAccounts.physicalAccountFingerprint,
          isDefault: schema.brokerAccounts.isDefault,
          displayName: schema.brokerAccounts.displayName,
        })
        .from(schema.brokerAccounts)
        .where(eq(schema.brokerAccounts.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async countSecretPayloads(id) {
      const rows = await db
        .select({ id: schema.brokerSecretPayloads.id })
        .from(schema.brokerSecretPayloads)
        .where(eq(schema.brokerSecretPayloads.brokerAccountId, id));
      return rows.length;
    },
    async countCredentialRefs(id) {
      const rows = await db
        .select({ id: schema.brokerCredentialRefs.id })
        .from(schema.brokerCredentialRefs)
        .where(eq(schema.brokerCredentialRefs.brokerAccountId, id));
      return rows.length;
    },
    async loadTradingState(id) {
      const rows = await db
        .select({
          autoTradingEnabled: schema.tradingAccountState.autoTradingEnabled,
          liquidating: schema.tradingAccountState.liquidating,
          unknownOrderCount: schema.tradingAccountState.unknownOrderCount,
          onboardingComplete: schema.tradingAccountState.onboardingComplete,
          circuitHalted: schema.tradingAccountState.circuitHalted,
        })
        .from(schema.tradingAccountState)
        .where(eq(schema.tradingAccountState.brokerAccountId, id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        autoTradingEnabled: Boolean(row.autoTradingEnabled),
        liquidating: Boolean(row.liquidating),
        unknownOrderCount: Number(row.unknownOrderCount ?? 0),
        onboardingComplete: Boolean(row.onboardingComplete),
        circuitHalted: Boolean(row.circuitHalted),
      };
    },
    async countUnresolvedOrders(id) {
      const rows = await db
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.brokerAccountId, id),
            inArray(schema.orders.status, [...UNRESOLVED_ORDER_STATUSES]),
          ),
        );
      return rows.length;
    },
    async countUnresolvedIntents(id) {
      const rows = await db
        .select({ id: schema.orderIntents.id })
        .from(schema.orderIntents)
        .where(
          and(
            eq(schema.orderIntents.brokerAccountId, id),
            inArray(schema.orderIntents.status, [...UNRESOLVED_INTENT_STATUSES]),
          ),
        );
      return rows.length;
    },
    async applyCredentialRebind(input) {
      await db.transaction(async (tx) => {
        // Lock: only the explicit broker account id may be updated.
        const locked = await tx
          .select({ id: schema.brokerAccounts.id, status: schema.brokerAccounts.status })
          .from(schema.brokerAccounts)
          .where(eq(schema.brokerAccounts.id, input.brokerAccountId))
          .limit(1);
        if (!locked[0] || locked[0].status !== "ACTIVE") {
          throw new Error("RECOVERY_REFUSED: target account missing or not ACTIVE inside transaction");
        }

        await tx
          .update(schema.brokerSecretPayloads)
          .set({
            ciphertext: input.ciphertext,
            iv: input.iv,
            authTag: input.authTag,
            keyVersion: input.keyVersion,
          })
          .where(eq(schema.brokerSecretPayloads.brokerAccountId, input.brokerAccountId));

        await tx
          .update(schema.brokerAccounts)
          .set({
            accountNumberMasked: input.accountNumberMasked,
            physicalAccountFingerprint: input.physicalAccountFingerprint,
          })
          .where(eq(schema.brokerAccounts.id, input.brokerAccountId));

        // Keep credential_refs row; align key_version only.
        await tx
          .update(schema.brokerCredentialRefs)
          .set({
            keyVersion: input.keyVersion,
            secretProvider: "local_aes_gcm",
            secretRef: `broker_secret_payloads:${input.brokerAccountId}`,
          })
          .where(eq(schema.brokerCredentialRefs.brokerAccountId, input.brokerAccountId));

        // Force autoTrading OFF (must remain false).
        await tx
          .update(schema.tradingAccountState)
          .set({
            autoTradingEnabled: false,
          })
          .where(eq(schema.tradingAccountState.brokerAccountId, input.brokerAccountId));
      });
    },
    async loadSecretPayload(id) {
      const rows = await db
        .select({
          ciphertext: schema.brokerSecretPayloads.ciphertext,
          iv: schema.brokerSecretPayloads.iv,
          authTag: schema.brokerSecretPayloads.authTag,
          keyVersion: schema.brokerSecretPayloads.keyVersion,
        })
        .from(schema.brokerSecretPayloads)
        .where(eq(schema.brokerSecretPayloads.brokerAccountId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/**
 * Mark local JSON startup sync stale without wiping account history/state.
 * Fail-closed: if file exists but cannot be patched, throw.
 */
export function invalidateAccountStartupSyncFile(brokerAccountId: string): {
  path: string;
  invalidated: boolean;
} {
  const statePath = path.join(process.cwd(), "data", "accounts", brokerAccountId, "state.json");
  if (!existsSync(statePath)) {
    return { path: statePath, invalidated: false };
  }
  const raw = readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.startupSync = emptyStartupSync();
  if (typeof parsed.autoTrading === "boolean") parsed.autoTrading = false;
  writeFileSync(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { path: statePath, invalidated: true };
}

export async function rebindPaperCredential(
  params: RebindPaperCredentialParams,
): Promise<RebindPaperCredentialResult> {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const log = params.log ?? ((line: string) => console.log(line));
  const checks: string[] = [];
  const apply = Boolean(params.apply);
  const dryRun = !apply;
  const brokerAccountId = params.brokerAccountId.trim();
  const secret: PaperCredentialSecret = {
    appKey: params.appKey.trim(),
    appSecret: params.appSecret.trim(),
    accountNo: params.accountNo.trim(),
  };
  const accountMasked = maskAccountNumber(secret.accountNo);

  const fail = (error: string): RebindPaperCredentialResult => ({
    ok: false,
    applied: false,
    dryRun,
    brokerAccountId,
    accountMasked,
    autoTradingOff: false,
    startupSyncRequired: true,
    kisValidationOk: false,
    error,
    checks,
  });

  try {
    assertEnvSafeForRecovery(env);
    checks.push("env_paper_locked");
    requireMasterKey(env);
    checks.push("master_key_present");

    if (!brokerAccountId) return fail("RECOVERY_BROKER_ACCOUNT_ID required");
    if (!normalizePaperAccountIdentity(secret.accountNo)) {
      return fail("RECOVERY_KIS_PAPER_ACCOUNT_NO invalid");
    }
    if (!secret.appKey || !secret.appSecret) {
      return fail("RECOVERY_KIS_PAPER_APP_KEY/SECRET required");
    }

    const store = params.store ?? (() => {
      const db = getDb(env);
      if (!db) throw new Error("DATABASE_URL unavailable");
      return createMysqlRebindStore(db);
    })();

    const account = await store.loadAccount(brokerAccountId);
    if (!account) return fail("RECOVERY_REFUSED: broker account not found");
    if (account.id !== brokerAccountId) {
      return fail("RECOVERY_REFUSED: broker account id mismatch");
    }
    checks.push("account_id_match");

    if (String(account.broker).toLowerCase() !== "kis") {
      return fail(`RECOVERY_REFUSED: broker=${account.broker} (kis required)`);
    }
    checks.push("broker_kis");

    if (account.environment !== "PAPER") {
      return fail(`RECOVERY_REFUSED: environment=${account.environment}`);
    }
    checks.push("environment_paper");

    if (account.status !== "ACTIVE") {
      return fail(`RECOVERY_REFUSED: status=${account.status} (ACTIVE required)`);
    }
    checks.push("status_active");

    if (!account.physicalAccountFingerprint) {
      return fail("RECOVERY_REFUSED: physicalAccountFingerprint missing");
    }
    checks.push("fingerprint_present");

    const payloadCount = await store.countSecretPayloads(brokerAccountId);
    if (payloadCount !== 1) {
      return fail(`RECOVERY_REFUSED: broker_secret_payloads count=${payloadCount} (exactly 1 required)`);
    }
    checks.push("secret_payload_count_1");

    const refCount = await store.countCredentialRefs(brokerAccountId);
    if (refCount !== 1) {
      return fail(`RECOVERY_REFUSED: broker_credential_refs count=${refCount} (exactly 1 required)`);
    }
    checks.push("credential_ref_count_1");

    const trading = await store.loadTradingState(brokerAccountId);
    if (!trading) return fail("RECOVERY_REFUSED: trading_account_state missing");
    if (trading.autoTradingEnabled) {
      return fail("RECOVERY_REFUSED: autoTradingEnabled=true");
    }
    if (trading.liquidating) {
      return fail("RECOVERY_REFUSED: liquidating=true");
    }
    if (trading.unknownOrderCount !== 0) {
      return fail(`RECOVERY_REFUSED: unknownOrderCount=${trading.unknownOrderCount}`);
    }
    checks.push("trading_state_safe");

    const openOrders = await store.countUnresolvedOrders(brokerAccountId);
    if (openOrders > 0) {
      return fail(`RECOVERY_REFUSED: unresolved orders=${openOrders}`);
    }
    checks.push("orders_clear");

    const openIntents = await store.countUnresolvedIntents(brokerAccountId);
    if (openIntents > 0) {
      return fail(`RECOVERY_REFUSED: unresolved intents=${openIntents}`);
    }
    checks.push("intents_clear");

    const expectedMask = account.accountNumberMasked;
    if (!expectedMask || accountMasked !== expectedMask) {
      return fail("RECOVERY_REFUSED: account_number_masked mismatch");
    }
    checks.push("account_mask_match");

    // Encrypt → decrypt round-trip on NEW secret only (never old DB ciphertext).
    const enc = encryptPaperCredentials(secret);
    const roundTrip = decryptPaperCredentials({
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    });
    if (!secretsEqual(secret, roundTrip)) {
      return fail("RECOVERY_REFUSED: encrypt/decrypt round-trip mismatch");
    }
    checks.push("encrypt_roundtrip_ok");

    // Fingerprint under CURRENT master key (may differ from stored HMAC under lost key).
    const nextFingerprint = paperPhysicalAccountFingerprint(secret.accountNo);
    if (!/^[a-f0-9]{64}$/.test(nextFingerprint)) {
      return fail("RECOVERY_REFUSED: fingerprint generation failed");
    }
    checks.push("fingerprint_computable");

    const validate = params.validate ?? validatePaperCredentials;
    const validated = await validate(secret);
    if (!validated.ok) {
      return fail(`RECOVERY_REFUSED: KIS validation failed (${validated.error ?? "unknown"})`);
    }
    checks.push("kis_readonly_ok");
    log(`rebind: KIS PAPER read-only validation OK account=${accountMasked}`);

    if (dryRun) {
      log(`rebind: DRY-RUN OK brokerAccountId=${brokerAccountId} account=${accountMasked}`);
      log("rebind: no DB mutation (set RECOVERY_APPLY=true + RECOVERY_CONFIRM to apply)");
      return {
        ok: true,
        applied: false,
        dryRun: true,
        brokerAccountId,
        accountMasked,
        autoTradingOff: true,
        startupSyncRequired: true,
        kisValidationOk: true,
        checks,
      };
    }

    if (String(params.confirm ?? "").trim() !== RECOVERY_CONFIRM_TOKEN) {
      return fail(
        `RECOVERY_REFUSED: RECOVERY_CONFIRM must be exactly ${RECOVERY_CONFIRM_TOKEN}`,
      );
    }
    checks.push("confirm_token_ok");

    await store.applyCredentialRebind({
      brokerAccountId,
      accountNumberMasked: accountMasked,
      physicalAccountFingerprint: nextFingerprint,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion,
    });
    checks.push("db_mutation_ok");

    // Post-apply decrypt of NEW ciphertext only.
    const stored = await store.loadSecretPayload(brokerAccountId);
    if (!stored) return fail("RECOVERY_REFUSED: payload missing after apply");
    const storedSecret = decryptPaperCredentials(stored);
    if (!secretsEqual(secret, storedSecret)) {
      return fail("RECOVERY_REFUSED: post-apply decrypt mismatch");
    }
    checks.push("post_apply_decrypt_ok");

    invalidateRuntimeScope(brokerAccountId);
    markScopeStartupSyncDone(brokerAccountId, false);
    const fileInv = invalidateAccountStartupSyncFile(brokerAccountId);
    checks.push(
      fileInv.invalidated ? "local_startup_sync_invalidated" : "local_startup_sync_absent",
    );

    log(`rebind: APPLIED brokerAccountId=${brokerAccountId} account=${accountMasked}`);
    log("rebind: autoTrading OFF; fresh Startup Sync required; orders NOT placed");

    return {
      ok: true,
      applied: true,
      dryRun: false,
      brokerAccountId,
      accountMasked,
      autoTradingOff: true,
      startupSyncRequired: true,
      kisValidationOk: true,
      checks,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "rebind failed";
    // Never append secret-bearing strings from unknown errors beyond message.
    return fail(message);
  }
}

/** Parse recovery params from process env (no CLI secret args). */
export function readRebindParamsFromEnv(env: Record<string, string | undefined> = process.env): {
  brokerAccountId: string;
  accountNo: string;
  appKey: string;
  appSecret: string;
  apply: boolean;
  confirm: string;
} {
  return {
    brokerAccountId: String(env.RECOVERY_BROKER_ACCOUNT_ID ?? "").trim(),
    accountNo: String(env.RECOVERY_KIS_PAPER_ACCOUNT_NO ?? "").trim(),
    appKey: String(env.RECOVERY_KIS_PAPER_APP_KEY ?? "").trim(),
    appSecret: String(env.RECOVERY_KIS_PAPER_APP_SECRET ?? "").trim(),
    apply: truthyApply(env.RECOVERY_APPLY),
    confirm: String(env.RECOVERY_CONFIRM ?? "").trim(),
  };
}

/** Redaction helper for tests: joined logs must not contain these. */
export function assertLogsHaveNoSecrets(
  joinedLogs: string,
  secrets: { appKey: string; appSecret: string; accountNo: string; masterKey: string },
): void {
  const needles = [
    secrets.appKey,
    secrets.appSecret,
    secrets.accountNo,
    secrets.masterKey,
    normalizePaperAccountIdentity(secrets.accountNo),
  ].filter((v) => v.length >= 4);
  for (const n of needles) {
    if (joinedLogs.includes(n)) {
      throw new Error("secret leaked into recovery logs");
    }
  }
}
