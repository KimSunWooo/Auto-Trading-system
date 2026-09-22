/**
 * Additive auth schema ensure — never DROP existing tables.
 */
import mysql from "mysql2/promise";
import { loadDbConnection } from "@/src/db/config";

export async function ensureAuthSchema(): Promise<void> {
  const cfg = loadDbConnection();
  if (!cfg) throw new Error("DATABASE_URL not configured");
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const [cols] = await conn.query<mysql.RowDataPacket[]>(
      "SHOW COLUMNS FROM users LIKE 'password_hash'",
    );
    if (!cols.length) {
      await conn.query("ALTER TABLE users ADD COLUMN password_hash VARCHAR(512) NULL");
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS broker_secret_payloads (
        id CHAR(36) NOT NULL,
        broker_account_id CHAR(36) NOT NULL,
        ciphertext TEXT NOT NULL,
        iv VARCHAR(64) NOT NULL,
        auth_tag VARCHAR(64) NOT NULL,
        key_version VARCHAR(80) NOT NULL DEFAULT 'v1',
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_broker_secret_payload_account (broker_account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } finally {
    await conn.end();
  }
}
