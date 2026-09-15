export type ProductRisk = {
  dailyLossPct: number;
  maxTickerWeight: number;
  stopLossPct: number;
};

export const DEFAULT_PRODUCT_RISK: ProductRisk = {
  dailyLossPct: 0.03,
  maxTickerWeight: 0.2,
  stopLossPct: 0.05,
};

export function mergeProductRisk(raw: unknown): ProductRisk {
  const input = raw && typeof raw === "object" ? (raw as Partial<ProductRisk>) : {};
  const dailyLossPct = asRatio(input.dailyLossPct, DEFAULT_PRODUCT_RISK.dailyLossPct);
  const maxTickerWeight = asRatio(input.maxTickerWeight, DEFAULT_PRODUCT_RISK.maxTickerWeight);
  const stopLossPct = asRatio(input.stopLossPct, DEFAULT_PRODUCT_RISK.stopLossPct);
  return { dailyLossPct, maxTickerWeight, stopLossPct };
}

function asRatio(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}
