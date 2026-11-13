/**
 * Extract mysql2 / drizzle-wrapped errno, code, and FK constraint name for logs.
 * Never includes connection URLs or credentials.
 */
export type MysqlErrorDetails = {
  code?: string;
  errno?: number;
  constraint?: string;
  sqlState?: string;
  sqlMessage?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickConstraint(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const named = message.match(/CONSTRAINT [`']([^`']+)[`']/i);
  if (named?.[1]) return named[1];
  const fk = message.match(/FOREIGN KEY \([^\)]+\) REFERENCES/i);
  if (fk && /fk_[a-z0-9_]+/i.test(message)) {
    const m = message.match(/(fk_[a-z0-9_]+)/i);
    return m?.[1];
  }
  return undefined;
}

function looksLikeMysqlDriverError(row: Record<string, unknown>): boolean {
  if (typeof row.errno === "number") return true;
  if (typeof row.sqlState === "string") return true;
  if (typeof row.sqlMessage === "string") return true;
  const code = typeof row.code === "string" ? row.code : "";
  return /^(ER_|ECONN|PROTOCOL_|EPIPE)/.test(code);
}

export function extractMysqlErrorDetails(err: unknown): MysqlErrorDetails {
  // Walk Error.cause chain — DatabaseLedgerError → drizzle → mysql2 driver.
  // Do not treat App Error.code (e.g. DATABASE_LEDGER_FAILED) as MySQL.
  let cur: unknown = err;
  let cause: Record<string, unknown> | null = null;
  const messages: string[] = [];
  for (let depth = 0; depth < 8 && cur; depth++) {
    const row = asRecord(cur);
    if (!row) break;
    if (typeof row.message === "string") messages.push(row.message);
    if (looksLikeMysqlDriverError(row)) {
      cause = row;
      break;
    }
    cur = row.cause;
  }
  if (!cause) return {};
  const code = typeof cause.code === "string" ? cause.code : undefined;
  const errno =
    typeof cause.errno === "number"
      ? cause.errno
      : typeof cause.errno === "string" && /^\d+$/.test(cause.errno)
        ? Number(cause.errno)
        : undefined;
  const sqlState = typeof cause.sqlState === "string" ? cause.sqlState : undefined;
  const sqlMessage =
    typeof cause.sqlMessage === "string"
      ? cause.sqlMessage
      : typeof cause.message === "string"
        ? cause.message
        : undefined;
  let constraint =
    (typeof cause.constraint === "string" ? cause.constraint : undefined) ??
    pickConstraint(sqlMessage);
  if (!constraint) {
    for (const msg of messages) {
      constraint = pickConstraint(msg);
      if (constraint) break;
    }
  }
  return { code, errno, constraint, sqlState, sqlMessage };
}

/** Compact one-line fragment for server logs. */
export function formatMysqlErrorForLog(err: unknown): string {
  const d = extractMysqlErrorDetails(err);
  const parts: string[] = [];
  if (d.code) parts.push(`cause.code=${d.code}`);
  if (d.errno != null) parts.push(`errno=${d.errno}`);
  if (d.constraint) parts.push(`constraint=${d.constraint}`);
  if (d.sqlState) parts.push(`sqlState=${d.sqlState}`);
  return parts.length ? parts.join(" ") : "";
}
