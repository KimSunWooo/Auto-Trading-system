/**
 * Multi-exchange overseas broker coverage helpers.
 * KIS inquire-balance / inquire-nccs are scoped by OVRS_EXCG_CD —
 * NASDAQ alone misses NYSE/AMEX holdings and open orders.
 */
import type { OverseasOpenOrder, OverseasPosition } from "@/src/markets/overseas/types";
import { US_EXCHANGES, type UsExchange } from "@/src/markets/overseas/instruments";

export type ExchangeProbeResult<T> = {
  exchange: UsExchange;
  ok: boolean;
  items: T[];
  error?: string;
};

export function mergeOverseasPositionsByIdentity(
  rows: OverseasPosition[],
): OverseasPosition[] {
  const byId = new Map<string, OverseasPosition>();
  for (const row of rows) {
    const key = row.identity;
    if (!key) continue;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, row);
      continue;
    }
    // Same EXCHANGE:SYMBOL — keep one row; prefer larger qty if pages overlap.
    byId.set(key, row.qty >= prev.qty ? row : prev);
  }
  return [...byId.values()];
}

export function mergeOverseasOpenOrdersByOdno(rows: OverseasOpenOrder[]): OverseasOpenOrder[] {
  const byOdno = new Map<string, OverseasOpenOrder>();
  for (const row of rows) {
    const key = String(row.orderNo ?? "").trim();
    if (!key) continue;
    if (!byOdno.has(key)) byOdno.set(key, row);
  }
  return [...byOdno.values()];
}

export function positionCoverageByExchange(positions: OverseasPosition[]): Record<UsExchange, number> {
  const out: Record<UsExchange, number> = { NASDAQ: 0, NYSE: 0, AMEX: 0 };
  for (const row of positions) {
    const ex = row.instrument?.exchange ?? (row.identity.includes(":") ? row.identity.split(":")[0] : null);
    if (ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX") out[ex] += 1;
  }
  return out;
}

export async function collectAllExchangeOpenOrders(
  fetchOne: (exchange: UsExchange) => Promise<OverseasOpenOrder[]>,
  exchanges: readonly UsExchange[] = US_EXCHANGES,
): Promise<{
  orders: OverseasOpenOrder[];
  probes: ExchangeProbeResult<OverseasOpenOrder>[];
}> {
  const probes: ExchangeProbeResult<OverseasOpenOrder>[] = [];
  for (const exchange of exchanges) {
    try {
      const items = await fetchOne(exchange);
      probes.push({ exchange, ok: true, items });
    } catch (err) {
      probes.push({
        exchange,
        ok: false,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    orders: mergeOverseasOpenOrdersByOdno(probes.flatMap((p) => p.items)),
    probes,
  };
}

export async function collectAllExchangePositions(
  fetchOne: (exchange: UsExchange) => Promise<OverseasPosition[]>,
  exchanges: readonly UsExchange[] = US_EXCHANGES,
): Promise<{
  positions: OverseasPosition[];
  probes: ExchangeProbeResult<OverseasPosition>[];
}> {
  const probes: ExchangeProbeResult<OverseasPosition>[] = [];
  for (const exchange of exchanges) {
    try {
      const items = await fetchOne(exchange);
      probes.push({ exchange, ok: true, items });
    } catch (err) {
      probes.push({
        exchange,
        ok: false,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    positions: mergeOverseasPositionsByIdentity(probes.flatMap((p) => p.items)),
    probes,
  };
}

/** True when every US exchange was probed and at least one succeeded. */
export function exchangeCoverageAttemptedOk<T>(probes: ExchangeProbeResult<T>[]): boolean {
  return probes.length >= 3 && probes.some((p) => p.ok);
}

/** True when every US exchange probe succeeded (empty holdings still count as ok). */
export function allExchangeProbesOk<T>(probes: ExchangeProbeResult<T>[]): boolean {
  return probes.length > 0 && probes.every((p) => p.ok);
}
