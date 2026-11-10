/**
 * Build MA history from KIS daily closes + live price without double-counting
 * today's developing bar when the chart already ends at the same close.
 */
export function mergeLiveIntoDailyCloses(daily: number[], livePrice: number, maxBars = 40): number[] {
  const base = daily.filter((n) => Number.isFinite(n) && n > 0).slice(-(maxBars));
  if (!(livePrice > 0)) return base.slice(-maxBars);
  if (base.length === 0) return [livePrice];
  const last = base[base.length - 1]!;
  // KIS daily chart often already includes today's developing close.
  if (last === livePrice) return base.slice(-maxBars);
  return [...base, livePrice].slice(-maxBars);
}
