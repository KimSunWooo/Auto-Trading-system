/**
 * Test-only seed corpus. Never imported by production search path
 * unless `allowSeedFallback: true` is explicit.
 */
import { UNIVERSE } from "@/lib/universe";
import { US_SEED_UNIVERSE } from "@/src/markets/overseas/instruments";
import { toInstrumentRef } from "@/src/instruments/types";
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";
import type { SearchableInstrument } from "@/src/instruments/search";
import type { InstrumentSearchQuery } from "@/src/instruments/types";

export function seedCorpusForTest(query: InstrumentSearchQuery): SearchableInstrument[] {
  const rows: SearchableInstrument[] = [];
  for (const stock of UNIVERSE) {
    rows.push(
      toInstrumentRef({
        country: "KR",
        market: stock.market,
        symbol: stock.code,
        displayName: stock.name,
        koreanName: stock.name,
        currency: "KRW",
      }),
    );
  }
  for (const stock of US_SEED_UNIVERSE) {
    rows.push(
      toInstrumentRef({
        country: "US",
        market: stock.exchange,
        symbol: stock.symbol,
        displayName: stock.displayName,
        englishName: stock.displayName,
        currency: "USD",
      }),
    );
  }
  for (const rep of configDashboardRepresentatives()) {
    if (!rows.some((r) => r.instrumentKey === rep.instrumentKey)) rows.push(rep);
  }
  return rows.filter((row) => {
    if (query.country && row.country.toUpperCase() !== query.country.toUpperCase()) return false;
    if (query.market && row.market.toUpperCase() !== query.market.toUpperCase()) return false;
    if (query.type && String(row.instrumentType).toUpperCase() !== query.type.toUpperCase()) return false;
    return true;
  });
}
