/**
 * Additive auth schema ensure — never DROP existing tables.
 * Includes PAPER physical_account_fingerprint column + unique claim.
 */
import mysql from "mysql2/promise";
import { loadDbConnection } from "@/src/db/config";
import { decryptPaperCredentials, paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT } from "@/src/runtime/paper-physical-account";

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

    await ensurePaperPhysicalFingerprintColumn(conn);
  } finally {
    await conn.end();
  }
}

async function ensurePaperPhysicalFingerprintColumn(conn: mysql.Connection): Promise<void> {
  const [fpCols] = await conn.query<mysql.RowDataPacket[]>(
    "SHOW COLUMNS FROM broker_accounts LIKE 'physical_account_fingerprint'",
  );
  if (!fpCols.length) {
    await conn.query(
      "ALTER TABLE broker_accounts ADD COLUMN physical_account_fingerprint VARCHAR(64) NULL",
    );
  }

  const [idx] = await conn.query<mysql.RowDataPacket[]>(
    "SHOW INDEX FROM broker_accounts WHERE Key_name = 'uq_broker_accounts_paper_physical'",
  );
  const [needsBackfill] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT id FROM broker_accounts
    WHERE UPPER(environment) = 'PAPER'
      AND UPPER(broker) IN ('KIS', 'kis')
      AND UPPER(status) = 'ACTIVE'
      AND physical_account_fingerprint IS NULL
    LIMIT 1
  `);

  if (needsBackfill.length || !idx.length) {
    await backfillActivePaperFingerprints(conn);
  }

  if (!idx.length) {
    await conn.query(`
      ALTER TABLE broker_accounts
      ADD UNIQUE KEY uq_broker_accounts_paper_physical (
        broker,
        environment,
        physical_account_fingerprint
      )
    `);
  }
}

type FingerprintPlan = {
  id: string;
  status: string;
  fingerprint: string | null;
  nextFingerprint: string | null;
};

/**
 * Two-phase backfill: plan all fingerprints, fail closed on duplicates,
 * then write. Never auto-disable/delete duplicate ACTIVE rows.
 */
async function backfillActivePaperFingerprints(conn: mysql.Connection): Promise<void> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(`
    SELECT id, status, environment, broker, physical_account_fingerprint, credential_ref
    FROM broker_accounts
    WHERE UPPER(environment) = 'PAPER'
      AND UPPER(broker) IN ('KIS', 'kis')
  `);

  const plans: FingerprintPlan[] = [];
  for (const row of rows) {
    const status = String(row.status ?? "").toUpperCase();
    if (status !== "ACTIVE") {
      plans.push({
        id: String(row.id),
        status,
        fingerprint: row.physical_account_fingerprint
          ? String(row.physical_account_fingerprint)
          : null,
        nextFingerprint: null, // release claim
      });
      continue;
    }

    const existing = row.physical_account_fingerprint
      ? String(row.physical_account_fingerprint)
      : null;
    const next = existing ?? (await resolveFingerprintForActiveRow(conn, row));
    plans.push({
      id: String(row.id),
      status,
      fingerprint: existing,
      nextFingerprint: next,
    });
  }

  const byFingerprint = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.status !== "ACTIVE" || !plan.nextFingerprint) continue;
    const list = byFingerprint.get(plan.nextFingerprint) ?? [];
    list.push(plan.id);
    byFingerprint.set(plan.nextFingerprint, list);
  }
  const dups = [...byFingerprint.entries()].filter(([, ids]) => ids.length > 1);
  if (dups.length > 0) {
    const detail = dups
      .map(([fp, ids]) => `fingerprint=${fp.slice(0, 8)}… ids=${ids.join(",")}`)
      .join("; ");
    throw new Error(
      `${DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT}: resolve before continuing (${detail})`,
    );
  }

  for (const plan of plans) {
    if (plan.status !== "ACTIVE") {
      if (plan.fingerprint != null) {
        await conn.query(
          "UPDATE broker_accounts SET physical_account_fingerprint = NULL WHERE id = ?",
          [plan.id],
        );
      }
      continue;
    }
    if (plan.fingerprint !== plan.nextFingerprint) {
      await conn.query(
        "UPDATE broker_accounts SET physical_account_fingerprint = ? WHERE id = ?",
        [plan.nextFingerprint, plan.id],
      );
    }
  }
}

async function resolveFingerprintForActiveRow(
  conn: mysql.Connection,
  row: mysql.RowDataPacket,
): Promise<string> {
  const [secrets] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT ciphertext, iv, auth_tag FROM broker_secret_payloads WHERE broker_account_id = ? LIMIT 1",
    [row.id],
  );
  const secretRow = secrets[0];
  if (secretRow?.ciphertext && secretRow?.iv && secretRow?.auth_tag) {
    const secret = decryptPaperCredentials({
      ciphertext: String(secretRow.ciphertext),
      iv: String(secretRow.iv),
      authTag: String(secretRow.auth_tag),
    });
    return paperPhysicalAccountFingerprint(secret.accountNo);
  }

  // Legacy operator row: credentials live in process env (credential_ref=env:KIS_PAPER).
  const ref = String(row.credential_ref ?? "");
  if (ref.startsWith("env:")) {
    const accountNo = String(process.env.KIS_PAPER_ACCOUNT_NO ?? "").trim();
    if (accountNo) {
      return paperPhysicalAccountFingerprint(accountNo);
    }
  }

  throw new Error(
    `${DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT}: ACTIVE PAPER account ${row.id} ` +
      `missing credentials for fingerprint backfill (credential_ref=${ref || "none"})`,
  );
}
