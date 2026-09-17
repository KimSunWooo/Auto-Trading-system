import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "@/src/db/schema";
import { loadDbConnection } from "@/src/db/config";
import type { EnvMap } from "@/src/runtime/trading-mode";

export type AppDb = MySql2Database<typeof schema>;

let pool: mysql.Pool | null = null;
let db: AppDb | null = null;

export function resetDbClientForTest(): void {
  const closing = pool;
  pool = null;
  db = null;
  void closing?.end().catch(() => undefined);
}

export async function closeDb(): Promise<void> {
  const closing = pool;
  pool = null;
  db = null;
  if (closing) await closing.end().catch(() => undefined);
}

export function createMysqlPool(env: EnvMap = process.env): mysql.Pool | null {
  const cfg = loadDbConnection(env);
  if (!cfg) return null;
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 8,
    enableKeepAlive: true,
    timezone: "Z",
    dateStrings: true,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
}

export function getDb(env: EnvMap = process.env): AppDb | null {
  if (db) return db;
  if (!pool) pool = createMysqlPool(env);
  if (!pool) return null;
  db = drizzle(pool, { schema, mode: "default" });
  return db;
}

export async function pingDb(env: EnvMap = process.env): Promise<boolean> {
  const local = getDb(env);
  if (!local || !pool) return false;
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
