/**
 * Read-only DB connectivity diagnose for local ops.
 * Never prints passwords, connection URLs, or SQL bind values.
 * Never CREATE/ALTER/GRANT/migrate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import mysql from "mysql2/promise";
import { loadDbConnection, persistenceMode, dbConfigured } from "@/src/db/config";

function loadDotEnvLocal(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      // Do not override inherited process env (matches common dotenv behavior for already-set keys).
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    console.error("diag: .env.local missing");
  }
}

function redact(err: unknown): Record<string, unknown> {
  const e = err as {
    message?: string;
    code?: string;
    errno?: number;
    sqlState?: string;
    name?: string;
  };
  const message = String(e?.message ?? err)
    .replace(/password=[^&\s'"]+/gi, "password=***")
    .replace(/mysql:\/\/[^@\s]+@/gi, "mysql://***@")
    .replace(/Access denied for user '[^']+'/gi, "Access denied for user '***'")
    .slice(0, 240);
  return {
    name: e?.name ?? "Error",
    code: e?.code ?? null,
    errno: e?.errno ?? null,
    sqlState: e?.sqlState ?? null,
    message,
  };
}

async function main() {
  loadDotEnvLocal();
  const started = Date.now();
  const cfg = loadDbConnection(process.env);
  console.log(
    JSON.stringify(
      {
        stage: "config",
        dbConfigured: dbConfigured(process.env),
        persistenceMode: persistenceMode(process.env),
        paperRuntimeOwner: process.env.PAPER_RUNTIME_OWNER ?? null,
        kisMode: process.env.KIS_MODE ?? null,
        tradingMode: process.env.TRADING_MODE ?? null,
        allowLiveTrading: process.env.ALLOW_LIVE_TRADING ?? null,
        broker: process.env.BROKER ?? null,
        hasMasterKey: Boolean(process.env.BROKER_CREDENTIAL_MASTER_KEY?.trim()),
        hasConn: Boolean(cfg),
        hostSet: Boolean(cfg?.host),
        port: cfg?.port ?? null,
        database: cfg?.database ?? null,
        ssl: cfg?.ssl ?? null,
        userSet: Boolean(cfg?.user),
        passwordSet: Boolean(cfg?.password),
      },
      null,
      2,
    ),
  );
  if (!cfg) {
    console.log(JSON.stringify({ stage: "abort", reason: "loadDbConnection returned null" }));
    process.exit(2);
  }

  // DNS
  try {
    const t0 = Date.now();
    const addrs = await dns.lookup(cfg.host, { all: true });
    console.log(
      JSON.stringify({
        stage: "dns",
        ok: true,
        ms: Date.now() - t0,
        addressCount: addrs.length,
        families: [...new Set(addrs.map((a) => a.family))],
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ stage: "dns", ok: false, error: redact(err) }));
    process.exit(3);
  }

  // TCP
  try {
    const t0 = Date.now();
    await new Promise<void>((resolveP, reject) => {
      const socket = net.connect({ host: cfg.host, port: cfg.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("TCP connect timeout"), { code: "ETIMEDOUT" }));
      }, 5_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolveP();
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    console.log(JSON.stringify({ stage: "tcp", ok: true, ms: Date.now() - t0, port: cfg.port }));
  } catch (err) {
    console.log(JSON.stringify({ stage: "tcp", ok: false, error: redact(err) }));
    process.exit(4);
  }

  // Auth + SELECT 1 (read-only)
  let conn: mysql.Connection | null = null;
  try {
    const t0 = Date.now();
    conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectTimeout: 8_000,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    });
    await conn.query("SELECT 1 AS ok");
    console.log(JSON.stringify({ stage: "auth_select1", ok: true, ms: Date.now() - t0 }));
  } catch (err) {
    console.log(JSON.stringify({ stage: "auth_select1", ok: false, error: redact(err) }));
    process.exit(5);
  }

  // broker_accounts existence / columns / privilege (information_schema + SELECT)
  try {
    const t0 = Date.now();
    const [tables] = await conn!.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broker_accounts'`,
    );
    const tableOk = Array.isArray(tables) && tables.length > 0;
    console.log(
      JSON.stringify({
        stage: "table_exists",
        ok: tableOk,
        ms: Date.now() - t0,
        table: "broker_accounts",
      }),
    );
    if (!tableOk) {
      process.exit(6);
    }
  } catch (err) {
    console.log(JSON.stringify({ stage: "table_exists", ok: false, error: redact(err) }));
    process.exit(6);
  }

  try {
    const needed = [
      "id",
      "user_id",
      "broker",
      "environment",
      "display_name",
      "account_number_masked",
      "base_currency",
      "status",
      "is_default",
      "credential_ref",
      "physical_account_fingerprint",
      "created_at",
      "updated_at",
    ];
    const [cols] = await conn!.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broker_accounts'`,
    );
    const names = new Set(
      (cols as Array<{ COLUMN_NAME: string }>).map((r) => String(r.COLUMN_NAME)),
    );
    const missing = needed.filter((c) => !names.has(c));
    console.log(
      JSON.stringify({
        stage: "columns",
        ok: missing.length === 0,
        missing,
        columnCount: names.size,
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ stage: "columns", ok: false, error: redact(err) }));
    process.exit(7);
  }

  try {
    const t0 = Date.now();
    // Same filter shape as account-engine-loop listActivePaperAccounts (read-only).
    const [rows] = await conn!.query(
      `SELECT id, user_id, broker, environment, status, is_default,
              LEFT(account_number_masked, 8) AS masked_prefix,
              CASE WHEN credential_ref IS NULL OR credential_ref = '' THEN 0 ELSE 1 END AS has_credential_ref,
              CASE WHEN physical_account_fingerprint IS NULL OR physical_account_fingerprint = '' THEN 0 ELSE 1 END AS has_fingerprint
       FROM broker_accounts
       WHERE status = 'ACTIVE' AND environment = 'PAPER'`,
    );
    const list = rows as Array<Record<string, unknown>>;
    console.log(
      JSON.stringify({
        stage: "worker_query",
        ok: true,
        ms: Date.now() - t0,
        activePaperCount: list.length,
        accounts: list.map((r) => ({
          idPrefix: String(r.id ?? "").slice(0, 8),
          userIdPrefix: String(r.user_id ?? "").slice(0, 8),
          broker: r.broker,
          environment: r.environment,
          status: r.status,
          isDefault: Boolean(r.is_default),
          maskedPrefix: r.masked_prefix ?? null,
          hasCredentialRef: Boolean(r.has_credential_ref),
          hasFingerprint: Boolean(r.has_fingerprint),
        })),
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ stage: "worker_query", ok: false, error: redact(err) }));
    process.exit(8);
  }

  // autoTrading flags for ACTIVE PAPER (no secrets)
  try {
    const [rows] = await conn!.query(
      `SELECT ba.id,
              CASE WHEN tas.auto_trading_enabled IS NULL THEN NULL
                   WHEN tas.auto_trading_enabled THEN 1 ELSE 0 END AS auto_trading_enabled
       FROM broker_accounts ba
       LEFT JOIN trading_account_state tas ON tas.broker_account_id = ba.id
       WHERE ba.status = 'ACTIVE' AND ba.environment = 'PAPER'`,
    );
    const list = rows as Array<Record<string, unknown>>;
    console.log(
      JSON.stringify({
        stage: "auto_trading_flags",
        ok: true,
        accounts: list.map((r) => ({
          idPrefix: String(r.id ?? "").slice(0, 8),
          autoTradingEnabled: r.auto_trading_enabled,
        })),
      }),
    );
  } catch (err) {
    console.log(JSON.stringify({ stage: "auto_trading_flags", ok: false, error: redact(err) }));
  }

  await conn!.end();
  console.log(JSON.stringify({ stage: "done", totalMs: Date.now() - started }));
}

main().catch((err) => {
  console.log(JSON.stringify({ stage: "fatal", error: redact(err) }));
  process.exit(1);
});
