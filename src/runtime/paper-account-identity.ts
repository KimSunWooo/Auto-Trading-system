/** Shared account-number normalization (no crypto / DB deps). */
export function normalizePaperAccountIdentity(accountNo: string): string {
  return String(accountNo ?? "")
    .trim()
    .replace(/[\s-]/g, "");
}
