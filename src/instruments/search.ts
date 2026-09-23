import { and, eq, like, or, sql } from "drizzle-orm";
import { UNIVERSE } from "@/lib/universe";
import { US_SEED_UNIVERSE } from "@/src/markets/overseas/instruments";
import { getDb, type AppDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { normalizeAlias, normalizeInstrumentText, normalizeSymbol } from "@/src/instruments/normalize";
import {
  toInstrumentRef,
  type InstrumentRef,
  type InstrumentSearchHit,
  type InstrumentSearchQuery,
} from "@/src/instruments/types";
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";

export type SearchRankKind =
  | "exact_symbol"
  | "exact_name"
  | "symbol_prefix"
  | "name_prefix"
  | "alias_prefix"
  | "contains";

const RANK_SCORE: Record<SearchRankKind, number> = {
  exact_symbol: 0,
  exact_name: 1,
  symbol_prefix: 2,
  name_prefix: 3,
  alias_prefix: 4,
  contains: 5,
};

export type SearchableInstrument = InstrumentRef & {
  aliases?: string[];
};

export type InstrumentSearchOptions = {
  /** Injected corpus (tests). When set, DB/seed paths are skipped. */
  corpus?: SearchableInstrument[];
  /** Injected DB. Pass null to force seed fallback. */
  db?: AppDb | null;
  /** Default 20. */
  limit?: number;
};

/**
 * Search instruments against MySQL `instruments` + `instrument_aliases` when DB
 * has rows; otherwise fall back to `lib/universe` + `US_SEED_UNIVERSE`.
 * Never calls KIS REST/WS.
 */
export async function searchInstruments(
  query: InstrumentSearchQuery,
  options: InstrumentSearchOptions = {},
): Promise<InstrumentSearchHit[]> {
  const limit = clampLimit(options.limit ?? query.limit);
  const qNorm = normalizeInstrumentText(query.q);
  if (!qNorm) {
    return emptyQueryHits(query, limit, options);
  }

  const corpus = options.corpus ?? (await loadSearchCorpus(query, options));
  return rankInstruments(corpus, qNorm, limit, query);
}

export function rankInstruments(
  corpus: SearchableInstrument[],
  qNorm: string,
  limit = 20,
  filters: Pick<InstrumentSearchQuery, "country" | "market" | "type"> = {},
): InstrumentSearchHit[] {
  const qSymbol = normalizeSymbol(qNorm);
  const hits: InstrumentSearchHit[] = [];

  for (const row of corpus) {
    if (!row.isActive && row.isActive !== undefined) continue;
    if (filters.country && row.country.toUpperCase() !== filters.country.toUpperCase()) continue;
    if (filters.market && row.market.toUpperCase() !== filters.market.toUpperCase()) continue;
    if (filters.type && String(row.instrumentType).toUpperCase() !== filters.type.toUpperCase()) continue;

    const matchedOn = matchKind(row, qNorm, qSymbol);
    if (!matchedOn) continue;
    hits.push({ ...row, rank: RANK_SCORE[matchedOn], matchedOn });
  }

  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.automationSupported !== b.automationSupported) return a.automationSupported ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
  return hits.slice(0, limit);
}

function matchKind(row: SearchableInstrument, qNorm: string, qSymbol: string): SearchRankKind | null {
  const symbol = normalizeSymbol(row.symbol);
  const names = [
    row.displayName,
    row.koreanName,
    row.englishName,
  ]
    .filter(Boolean)
    .map((n) => normalizeInstrumentText(n));
  const aliases = (row.aliases ?? []).map((a) => normalizeAlias(a));

  if (symbol === qSymbol) return "exact_symbol";
  if (names.some((n) => n === qNorm)) return "exact_name";
  if (symbol.startsWith(qSymbol)) return "symbol_prefix";
  if (names.some((n) => n.startsWith(qNorm))) return "name_prefix";
  if (aliases.some((a) => a === qNorm || a.startsWith(qNorm))) return "alias_prefix";
  if (
    symbol.includes(qSymbol) ||
    names.some((n) => n.includes(qNorm)) ||
    aliases.some((a) => a.includes(qNorm))
  ) {
    return "contains";
  }
  return null;
}

function clampLimit(limit: number | undefined): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(100, Math.floor(n));
}

async function loadSearchCorpus(
  query: InstrumentSearchQuery,
  options: InstrumentSearchOptions,
): Promise<SearchableInstrument[]> {
  const db = options.db === undefined ? getDb() : options.db;
  if (db) {
    const fromDb = await loadFromDb(db, query);
    if (fromDb.length > 0) return fromDb;
  }
  return seedCorpus(query);
}

async function loadFromDb(db: AppDb, query: InstrumentSearchQuery): Promise<SearchableInstrument[]> {
  try {
    const conditions = [eq(schema.instruments.isActive, true)];
    if (query.country) conditions.push(eq(schema.instruments.country, query.country.toUpperCase()));
    if (query.market) conditions.push(eq(schema.instruments.market, query.market.toUpperCase()));
    if (query.type) conditions.push(eq(schema.instruments.instrumentType, query.type.toUpperCase()));

    const qNorm = normalizeInstrumentText(query.q);
    const likePat = `%${qNorm.replace(/[%_]/g, "")}%`;

    const rows = await db
      .select({
        id: schema.instruments.id,
        country: schema.instruments.country,
        market: schema.instruments.market,
        symbol: schema.instruments.symbol,
        displayName: schema.instruments.displayName,
        koreanName: schema.instruments.koreanName,
        englishName: schema.instruments.englishName,
        currency: schema.instruments.currency,
        instrumentType: schema.instruments.instrumentType,
        isActive: schema.instruments.isActive,
        kisExchangeCode: schema.instruments.kisExchangeCode,
        alias: schema.instrumentAliases.alias,
      })
      .from(schema.instruments)
      .leftJoin(
        schema.instrumentAliases,
        eq(schema.instrumentAliases.instrumentId, schema.instruments.id),
      )
      .where(
        and(
          ...conditions,
          or(
            like(sql`LOWER(${schema.instruments.symbol})`, likePat.toLowerCase()),
            like(sql`LOWER(${schema.instruments.displayName})`, likePat.toLowerCase()),
            like(sql`LOWER(COALESCE(${schema.instruments.koreanName}, ''))`, likePat.toLowerCase()),
            like(sql`LOWER(COALESCE(${schema.instruments.englishName}, ''))`, likePat.toLowerCase()),
            like(sql`LOWER(COALESCE(${schema.instrumentAliases.normalizedAlias}, ''))`, likePat.toLowerCase()),
          ),
        ),
      )
      .limit(500);

    const byId = new Map<string, SearchableInstrument>();
    for (const row of rows) {
      const current = byId.get(row.id);
      if (current) {
        if (row.alias) {
          current.aliases = [...new Set([...(current.aliases ?? []), row.alias])];
        }
        continue;
      }
      byId.set(
        row.id,
        toInstrumentRef({
          id: row.id,
          country: row.country,
          market: row.market,
          symbol: row.symbol,
          displayName: row.displayName,
          koreanName: row.koreanName,
          englishName: row.englishName,
          currency: row.currency,
          instrumentType: row.instrumentType,
          isActive: Boolean(row.isActive),
          kisExchangeCode: row.kisExchangeCode,
          aliases: row.alias ? [row.alias] : [],
        }),
      );
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

function seedCorpus(query: InstrumentSearchQuery): SearchableInstrument[] {
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
  // Include dashboard reps so UI always has known anchors even if universe drifts.
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

function emptyQueryHits(
  query: InstrumentSearchQuery,
  limit: number,
  options: InstrumentSearchOptions,
): InstrumentSearchHit[] {
  if (options.corpus) {
    return options.corpus
      .filter((row) => {
        if (query.country && row.country.toUpperCase() !== query.country.toUpperCase()) return false;
        if (query.market && row.market.toUpperCase() !== query.market.toUpperCase()) return false;
        return true;
      })
      .slice(0, limit)
      .map((row) => ({ ...row, rank: 99, matchedOn: "contains" as const }));
  }
  const reps = configDashboardRepresentatives(query.country)
    .filter((row) => !query.market || row.market.toUpperCase() === query.market.toUpperCase())
    .slice(0, limit);
  return reps.map((row) => ({ ...row, rank: 99, matchedOn: "contains" as const }));
}
