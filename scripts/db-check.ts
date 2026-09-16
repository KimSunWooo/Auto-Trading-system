import mysql from "mysql2/promise";
import { EXPECTED_OBJECTS } from "@/src/db/expected";
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
    if (!missing.length) {
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
