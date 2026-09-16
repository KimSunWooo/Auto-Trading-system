/** Persist DECIMAL(28,8) as strings. Do not round-trip authoritative money through float. */
export function money(value: number | string | null | undefined): string {
  if (value == null || value === "") return "0.00000000";
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0.00000000";
    return n.toFixed(8);
  }
  if (!Number.isFinite(value)) return "0.00000000";
  return value.toFixed(8);
}

export function moneyNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
