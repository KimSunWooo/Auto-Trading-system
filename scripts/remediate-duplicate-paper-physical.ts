/**
 * Operator remediation (NOT part of auto-migration).
 * Releases ACTIVE claim on legacy env:KIS_PAPER broker_accounts row when it
 * collides with a user-owned local-secret ACTIVE PAPER account (same physical CANO).
 *
 * Does not delete history. Sets status=DISABLED + fingerprint=NULL.
 * Run only after confirming DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT from ensureAuthSchema.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

async function main() {
  const mysql = await import("mysql2/promise");
  const { loadDbConnection } = await import("@/src/db/config");
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
    const envRefId = process.env.REMEDIATE_BROKER_ACCOUNT_ID?.trim();
    if (!envRefId) {
      console.error(
        "Set REMEDIATE_BROKER_ACCOUNT_ID to the env:KIS_PAPER (or other) ACTIVE id to disable.",
      );
      process.exit(2);
    }
    const [rows] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT id, status, credential_ref, physical_account_fingerprint FROM broker_accounts WHERE id = ?",
      [envRefId],
    );
    const row = rows[0];
    if (!row) throw new Error("broker_account not found");
    console.log(
      `Remediating id=${row.id} status=${row.status} credential_ref=${row.credential_ref} ` +
        `fp=${row.physical_account_fingerprint ? String(row.physical_account_fingerprint).slice(0, 8) + "…" : "null"}`,
    );
    await conn.query(
      "UPDATE broker_accounts SET status = 'DISABLED', is_default = 0, physical_account_fingerprint = NULL WHERE id = ?",
      [envRefId],
    );
    console.log("Done: DISABLED + fingerprint released. History preserved.");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
