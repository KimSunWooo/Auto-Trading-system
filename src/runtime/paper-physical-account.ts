/**
 * Exclusive ACTIVE ownership of one physical KIS PAPER account (CANO identity).
 * Cross-runtime bootstrap vs accounts is handled by PAPER_RUNTIME_OWNER.
 * DB unique(broker, environment, physical_account_fingerprint) is the authority;
 * application precheck is convenience only.
 */
export { normalizePaperAccountIdentity } from "@/src/runtime/paper-account-identity";
import { normalizePaperAccountIdentity } from "@/src/runtime/paper-account-identity";

export type PaperPhysicalAccountCandidate = {
  id: string;
  /** Normalized account identity (digits only). Empty = skip. */
  identity: string;
  status?: string;
  environment?: string;
  /** Optional keyed fingerprint when already computed. */
  fingerprint?: string | null;
};

/**
 * Returns the conflicting ACTIVE PAPER broker_account id, or null.
 * Prefers fingerprint match when both sides have fingerprints.
 */
export function findDuplicateActivePaperPhysicalAccount(
  candidates: PaperPhysicalAccountCandidate[],
  nextAccountNo: string,
  opts: { excludeBrokerAccountId?: string; nextFingerprint?: string } = {},
): string | null {
  const next = normalizePaperAccountIdentity(nextAccountNo);
  if (!next && !opts.nextFingerprint) return null;
  for (const row of candidates) {
    if (opts.excludeBrokerAccountId && row.id === opts.excludeBrokerAccountId) continue;
    const status = (row.status ?? "ACTIVE").toUpperCase();
    const env = (row.environment ?? "PAPER").toUpperCase();
    if (status !== "ACTIVE") continue;
    if (env !== "PAPER") continue;
    if (opts.nextFingerprint && row.fingerprint) {
      if (row.fingerprint === opts.nextFingerprint) return row.id;
      continue;
    }
    const idn = normalizePaperAccountIdentity(row.identity);
    if (!idn || !next) continue;
    if (idn === next) return row.id;
  }
  return null;
}

export const ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED =
  "ACTIVE PAPER physical account already registered" as const;

export const DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT =
  "DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT" as const;

export function isMysqlDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errno?: number; code?: string; message?: string };
  if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
  return /Duplicate entry/i.test(String(e.message ?? ""));
}

function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function sanitizePaperPhysicalOwnershipError(err: unknown): Error {
  if (err instanceof Error && err.message.includes(ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED)) {
    return err;
  }
  const chain = errorChain(err);
  const messages = chain
    .map((e) => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? "")))
    .join("\n");
  const hasDup = chain.some((e) => isMysqlDuplicateKeyError(e));
  const touchesPaperPhysical =
    /physical_account_fingerprint|uq_broker_accounts_paper_physical/i.test(messages) ||
    (/Failed query: insert into `broker_accounts`/i.test(messages) && hasDup);
  if (hasDup && touchesPaperPhysical) {
    return new Error(ACTIVE_PAPER_PHYSICAL_ALREADY_REGISTERED);
  }
  return err instanceof Error ? err : new Error(String(err));
}
