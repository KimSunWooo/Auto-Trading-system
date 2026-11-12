/**
 * Approved AWS RDS authority for PAPER trading.
 * Local MySQL / JSON / mirror are not substitutes when enabling auto-trading
 * or submitting new orders under PERSISTENCE_MODE=database.
 */
import { getDb, getMysqlPool, pingDb } from "@/src/db/client";
import {
  dbConfigured,
  isDatabaseLedgerAuthority,
  loadDbConnection,
  persistenceMode,
  type DbConnectionConfig,
} from "@/src/db/config";
import { recordMirrorDegraded, recordMirrorSuccess } from "@/src/db/status";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import type { EnvMap } from "@/src/runtime/trading-mode";

export type RdsAuthorityDenyCode =
  | "PERSISTENCE_NOT_DATABASE"
  | "NOT_CONFIGURED"
  | "HOST_NOT_APPROVED"
  | "LOCAL_HOST_DENIED"
  | "PING_FAILED"
  | "SCHEMA_QUERY_FAILED";

export type RdsAuthorityConfigResult =
  | {
      ok: true;
      host: string;
      database: string;
      persistenceMode: "database";
    }
  | {
      ok: false;
      code: RdsAuthorityDenyCode;
      message: string;
    };

export type RdsAuthorityLiveResult =
  | {
      ok: true;
      host: string;
      database: string;
      persistenceMode: "database";
      ping: true;
      schemaOk: true;
    }
  | {
      ok: false;
      code: RdsAuthorityDenyCode;
      message: string;
      ping?: boolean;
      schemaOk?: boolean;
    };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export function isApprovedRdsHost(host: string | undefined): boolean {
  const h = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!h) return false;
  if (LOCAL_HOSTS.has(h)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // raw IPs are never approved ops RDS
  return h.endsWith(".rds.amazonaws.com");
}

export function isLocalDbHost(host: string | undefined): boolean {
  const h = String(host ?? "")
    .trim()
    .toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith(".local");
}

/**
 * Config-only gate (no network). Used by order precheck and worker start refuse.
 * Test processes may use any configured DB so unit tests stay isolated.
 */
export function evaluateApprovedRdsConfig(
  env: EnvMap = process.env,
  opts: { allowTestNonRds?: boolean } = {},
): RdsAuthorityConfigResult {
  const allowTest = opts.allowTestNonRds ?? isNodeTestProcess(env);
  const mode = persistenceMode(env);
  if (mode !== "database" || !isDatabaseLedgerAuthority(env)) {
    return {
      ok: false,
      code: "PERSISTENCE_NOT_DATABASE",
      message: "PERSISTENCE_MODE=database 가 필요합니다 — 로컬 JSON/mirror 대체 금지",
    };
  }
  if (!dbConfigured(env)) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "승인된 RDS DATABASE_URL / AWS_RDS_* 가 설정되지 않았습니다",
    };
  }
  const cfg = loadDbConnection(env);
  if (!cfg) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "DB 연결 설정을 파싱하지 못했습니다",
    };
  }
  if (allowTest) {
    return {
      ok: true,
      host: cfg.host,
      database: cfg.database,
      persistenceMode: "database",
    };
  }
  if (isLocalDbHost(cfg.host)) {
    return {
      ok: false,
      code: "LOCAL_HOST_DENIED",
      message: "로컬 MySQL 호스트는 운용 RDS로 사용할 수 없습니다",
    };
  }
  if (!isApprovedRdsHost(cfg.host)) {
    return {
      ok: false,
      code: "HOST_NOT_APPROVED",
      message: "호스트가 승인된 AWS RDS(*.rds.amazonaws.com)가 아닙니다",
    };
  }
  return {
    ok: true,
    host: cfg.host,
    database: cfg.database,
    persistenceMode: "database",
  };
}

/** Trading schema tables that must be readable on the approved RDS. */
const REQUIRED_SCHEMA_TABLES = [
  "broker_accounts",
  "trading_account_state",
  "orders",
  "executions",
] as const;

type RdsLiveCacheSlot = {
  at: number;
  key: string;
  result: RdsAuthorityLiveResult;
};

type RdsGlobal = typeof globalThis & {
  __miraeRdsLiveCache?: RdsLiveCacheSlot | null;
};

const RDS_LIVE_TTL_MS = 30_000;

function cacheKey(env: EnvMap, cfg: DbConnectionConfig): string {
  return `${persistenceMode(env)}|${cfg.host}|${cfg.port}|${cfg.database}`;
}

/**
 * Live ping + schema SELECT. Records mirror success/failure for /api/runtime/database.
 * Never falls back to local MySQL or JSON.
 */
export async function verifyApprovedRdsLive(
  env: EnvMap = process.env,
  opts: { allowTestNonRds?: boolean; budgetMs?: number } = {},
): Promise<RdsAuthorityLiveResult> {
  const budgetMs = opts.budgetMs ?? 8_000;
  const started = Date.now();
  const timedOut = () => Date.now() - started > budgetMs;

  const cfgCheck = evaluateApprovedRdsConfig(env, opts);
  if (!cfgCheck.ok) {
    return {
      ok: false,
      code: cfgCheck.code,
      message: cfgCheck.message,
      ping: false,
      schemaOk: false,
    };
  }

  const cfg: DbConnectionConfig | null = loadDbConnection(env);
  if (!cfg) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "DB 연결 설정을 파싱하지 못했습니다",
      ping: false,
      schemaOk: false,
    };
  }

  // Ensure pool exists before ping.
  getDb(env);
  getMysqlPool(env);

  if (timedOut()) {
    return {
      ok: false,
      code: "PING_FAILED",
      message: "RDS 확인 대기 한도를 초과했습니다",
      ping: false,
      schemaOk: false,
    };
  }

  const ping = await pingDb(env);
  if (!ping) {
    recordMirrorDegraded("RDS ping failed — SELECT 1");
    return {
      ok: false,
      code: "PING_FAILED",
      message: "승인된 RDS에 연결하지 못했습니다 (ping)",
      ping: false,
      schemaOk: false,
    };
  }

  const db = getDb(env);
  const pool = getMysqlPool(env);
  if (!db || !pool) {
    recordMirrorDegraded("RDS pool unavailable after ping");
    return {
      ok: false,
      code: "PING_FAILED",
      message: "RDS 연결 풀을 확보하지 못했습니다",
      ping: false,
      schemaOk: false,
    };
  }

  try {
    for (const table of REQUIRED_SCHEMA_TABLES) {
      if (timedOut()) {
        return {
          ok: false,
          code: "SCHEMA_QUERY_FAILED",
          message: "RDS 스키마 확인 대기 한도를 초과했습니다",
          ping: true,
          schemaOk: false,
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "schema query failed";
    recordMirrorDegraded(`RDS schema query failed: ${msg}`);
    return {
      ok: false,
      code: "SCHEMA_QUERY_FAILED",
      message: `거래 스키마 조회 실패: ${msg}`.slice(0, 300),
      ping: true,
      schemaOk: false,
    };
  }

  recordMirrorSuccess();
  return {
    ok: true,
    host: cfgCheck.host,
    database: cfgCheck.database,
    persistenceMode: "database",
    ping: true,
    schemaOk: true,
  };
}

/**
 * Reuse a recent successful live verify for the same DSN (default 30s).
 * Failures are never cached as success; callers still get a live check when TTL expires.
 */
export async function verifyApprovedRdsLiveCached(
  env: EnvMap = process.env,
  opts: { allowTestNonRds?: boolean; budgetMs?: number; ttlMs?: number } = {},
): Promise<RdsAuthorityLiveResult> {
  const ttl = opts.ttlMs ?? RDS_LIVE_TTL_MS;
  const cfg = loadDbConnection(env);
  const g = globalThis as RdsGlobal;
  if (cfg && g.__miraeRdsLiveCache) {
    const hit = g.__miraeRdsLiveCache;
    if (
      hit.result.ok &&
      hit.key === cacheKey(env, cfg) &&
      Date.now() - hit.at < ttl
    ) {
      return hit.result;
    }
  }
  const result = await verifyApprovedRdsLive(env, opts);
  if (cfg && result.ok) {
    g.__miraeRdsLiveCache = { at: Date.now(), key: cacheKey(env, cfg), result };
  }
  return result;
}

export function clearRdsLiveCacheForTest(): void {
  (globalThis as RdsGlobal).__miraeRdsLiveCache = null;
}

/**
 * Order-path config gate: database mode must target approved RDS (or test DB).
 * Live disconnect is enforced by persistTradingLedger throwing before KIS POST.
 */
export function assertApprovedRdsConfigForOrders(env: EnvMap = process.env): string | null {
  const result = evaluateApprovedRdsConfig(env);
  if (result.ok) return null;
  return `${result.message} — 신규 주문 차단`;
}
