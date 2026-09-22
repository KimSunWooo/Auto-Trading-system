import mysql from "mysql2/promise";
import {
  EXPECTED_BROKER_ACCOUNTS_COLUMNS,
  EXPECTED_BROKER_ACCOUNTS_INDEXES,
  EXPECTED_OBJECTS,
} from "@/src/db/expected";
import { loadDbConnection } from "@/src/db/config";
import { loadLocalEnv } from "@/src/db/load-env";

loadLocalEnv();

async function main() {
  const cfg = loadDbConnection();
  if (!cfg) {
    console.log("db:check skipped: DATABASE_URL / AWS_RDS_* not set. Default persistence is json.");
    return;
  }
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>("SHOW FULL TABLES");
    const names = rows
      .map((row) => String(Object.values(row)[0] ?? ""))
      .filter(Boolean)
      .sort();
    const expected = [...EXPECTED_OBJECTS].sort();
    const missing = expected.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !expected.includes(name as (typeof expected)[number]));
    console.log(`db:check connected database=${cfg.database} host=${cfg.host.replace(/^.*?(?=rds\.|$)/, "***")}`);
    console.log(`objects=${names.length} expected=${expected.length}`);
    if (missing.length) {
      console.error(`missing: ${missing.join(", ")}`);
      process.exitCode = 1;
    }
    if (extra.length) {
      console.log(`extra (non-fatal): ${extra.join(", ")}`);
    }

    // Additive PAPER physical ownership column / unique index (ensureAuthSchema applies).
    if (names.includes("broker_accounts")) {
      const [cols] = await conn.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM broker_accounts");
      const colNames = cols.map((c) => String(c.Field));
      const missingCols = EXPECTED_BROKER_ACCOUNTS_COLUMNS.filter((c) => !colNames.includes(c));
      if (missingCols.length) {
        console.error(`broker_accounts missing columns: ${missingCols.join(", ")}`);
        console.error("Run app ensureAuthSchema / connect path once, or apply additive ALTER.");
        process.exitCode = 1;
      }
      const [idx] = await conn.query<mysql.RowDataPacket[]>("SHOW INDEX FROM broker_accounts");
      const idxNames = [...new Set(idx.map((r) => String(r.Key_name)))];
      const missingIdx = EXPECTED_BROKER_ACCOUNTS_INDEXES.filter((n) => !idxNames.includes(n));
      if (missingIdx.length) {
        console.error(`broker_accounts missing indexes: ${missingIdx.join(", ")}`);
        process.exitCode = 1;
      }
    }

    if (!missing.length && !process.exitCode) {
      console.log("Existing RDS baseline: ADOPTED");
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "db:check failed");
  process.exitCode = 1;
});
