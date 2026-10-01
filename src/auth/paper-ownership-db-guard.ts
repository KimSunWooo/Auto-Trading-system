/**
 * Pre-connect / pre-write gate for PAPER physical ownership DB integration tests.
 *
 * Localhost alone is NOT sufficient (SSH tunnels / port-forwards can look local).
 * All of the following must hold before any schema ensure or ledger write:
 *   1. RUN_PAPER_OWNERSHIP_DB_TESTS=1 (explicit opt-in)
 *   2. Host is an allowed loopback name
 *   3. Database name is the dedicated ownership test database
 *   4. BROKER_CREDENTIAL_MASTER_KEY is set
 *
 * Never opens a network connection — callers must not invoke mysql create*
 * unless evaluatePaperOwnershipDbAccess(...).ok === true.
 */
import type { DbConnectionConfig } from "@/src/db/config";
import type { EnvMap } from "@/src/runtime/trading-mode";

/** Dedicated local DB name — must not equal production / shared ledger names. */
export const PAPER_OWNERSHIP_TEST_DB_NAME = "auto_trading_test";

/** Explicit integration flag required before any ownership DB write. */
export const PAPER_OWNERSHIP_DB_TESTS_FLAG = "RUN_PAPER_OWNERSHIP_DB_TESTS";

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type PaperOwnershipDbDenyCode =
  | "FLAG_OFF"
  | "NOT_CONFIGURED"
  | "HOST_DENIED"
  | "DB_NAME_DENIED"
  | "MASTER_KEY_MISSING";

export type PaperOwnershipDbAccess =
  | {
      ok: true;
      host: string;
      port: number;
      database: string;
    }
  | {
      ok: false;
      code: PaperOwnershipDbDenyCode;
      reason: string;
    };

function envOf(env: EnvMap, key: string): string {
  return String(env[key] ?? "").trim();
}

export function isAllowedPaperOwnershipDbHost(host: string | undefined): boolean {
  return ALLOWED_HOSTS.has(String(host ?? "").trim().toLowerCase());
}

export function isPaperOwnershipTestDatabase(database: string | undefined): boolean {
  return String(database ?? "").trim() === PAPER_OWNERSHIP_TEST_DB_NAME;
}

export function isPaperOwnershipDbTestsFlagOn(env: EnvMap = process.env): boolean {
  const raw = envOf(env, PAPER_OWNERSHIP_DB_TESTS_FLAG).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pure decision — never touches the network.
 * Pass the already-parsed connection config (or null) plus env.
 */
export function evaluatePaperOwnershipDbAccess(
  cfg: DbConnectionConfig | null,
  env: EnvMap = process.env,
): PaperOwnershipDbAccess {
  if (!isPaperOwnershipDbTestsFlagOn(env)) {
    return {
      ok: false,
      code: "FLAG_OFF",
      reason: `${PAPER_OWNERSHIP_DB_TESTS_FLAG}=1 required for ownership DB writes`,
    };
  }
  if (!cfg) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      reason: "DATABASE_URL / DB connection not configured",
    };
  }
  if (!isAllowedPaperOwnershipDbHost(cfg.host)) {
    return {
      ok: false,
      code: "HOST_DENIED",
      reason: `ownership DB host denied (allowed: 127.0.0.1/localhost/::1)`,
    };
  }
  if (!isPaperOwnershipTestDatabase(cfg.database)) {
    return {
      ok: false,
      code: "DB_NAME_DENIED",
      reason: `ownership DB name must be exactly ${PAPER_OWNERSHIP_TEST_DB_NAME}`,
    };
  }
  if (!envOf(env, "BROKER_CREDENTIAL_MASTER_KEY")) {
    return {
      ok: false,
      code: "MASTER_KEY_MISSING",
      reason: "BROKER_CREDENTIAL_MASTER_KEY required",
    };
  }
  return {
    ok: true,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
  };
}

/**
 * Factory wrapper for connection creators.
 * If access is denied, `createConnection` is never invoked (ops / wrong DB stay untouched).
 */
export function connectOnlyIfPaperOwnershipDbAllowed<T>(
  cfg: DbConnectionConfig | null,
  env: EnvMap,
  createConnection: (allowed: DbConnectionConfig) => T,
): { access: PaperOwnershipDbAccess; connection: T | null } {
  const access = evaluatePaperOwnershipDbAccess(cfg, env);
  if (!access.ok) {
    return { access, connection: null };
  }
  if (!cfg) {
    return {
      access: {
        ok: false,
        code: "NOT_CONFIGURED",
        reason: "DATABASE_URL / DB connection not configured",
      },
      connection: null,
    };
  }
  return { access, connection: createConnection(cfg) };
}
