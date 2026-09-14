export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, n) => sum + n, 0) / period;
}

export function rangeBreak(open: number, high: number, low: number, k = 0.5): number {
  return open + (high - low) * k;
}
