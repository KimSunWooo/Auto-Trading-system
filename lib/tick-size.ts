/** KRX tick size (unified 2023 rules, simplified). */
export function tickSize(price: number): number {
  const p = Math.abs(price);
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}

export function roundToTick(price: number): number {
  const tick = tickSize(price);
  return Math.max(tick, Math.round(price / tick) * tick);
}

export function clampDailyLimit(next: number, prevClose: number): number {
  const limit = prevClose * 0.3;
  const lo = roundToTick(prevClose - limit);
  const hi = roundToTick(prevClose + limit);
  return Math.min(hi, Math.max(lo, roundToTick(next)));
}
