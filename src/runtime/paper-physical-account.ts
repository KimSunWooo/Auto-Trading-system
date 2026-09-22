/**
 * Exclusive ACTIVE ownership of one physical KIS PAPER account (CANO identity).
 * Cross-runtime bootstrap vs accounts is handled by PAPER_RUNTIME_OWNER.
 * This module blocks two ACTIVE broker_account rows sharing the same identity.
 */
export function normalizePaperAccountIdentity(accountNo: string): string {
  return String(accountNo ?? "")
    .trim()
    .replace(/[\s-]/g, "");
}

export type PaperPhysicalAccountCandidate = {
  id: string;
  /** Normalized account identity (digits only). Empty = skip. */
  identity: string;
  status?: string;
  environment?: string;
};

/**
 * Returns the conflicting ACTIVE PAPER broker_account id, or null.
 */
export function findDuplicateActivePaperPhysicalAccount(
  candidates: PaperPhysicalAccountCandidate[],
  nextAccountNo: string,
  opts: { excludeBrokerAccountId?: string } = {},
): string | null {
  const next = normalizePaperAccountIdentity(nextAccountNo);
  if (!next) return null;
  for (const row of candidates) {
    if (opts.excludeBrokerAccountId && row.id === opts.excludeBrokerAccountId) continue;
    const status = (row.status ?? "ACTIVE").toUpperCase();
    const env = (row.environment ?? "PAPER").toUpperCase();
    if (status !== "ACTIVE") continue;
    if (env !== "PAPER") continue;
    const idn = normalizePaperAccountIdentity(row.identity);
    if (!idn) continue;
    if (idn === next) return row.id;
  }
  return null;
}
