import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, eq, notInArray, sql } from "drizzle-orm";
import AdmZip from "adm-zip";
import { getDb, type AppDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { newId, stableId } from "@/src/db/ids";
import { mysqlDateUtc } from "@/src/db/time";
import { normalizeAlias } from "@/src/instruments/normalize";
import {
  parseKrMaster,
  parseKrMstBinary,
  parseNasdaqListed,
  parseOtherListed,
  parseUsMaster,
  type ParsedMasterRow,
} from "@/src/instruments/parsers";
import { makeInstrumentKey } from "@/src/instruments/types";

export type InstrumentSyncSourceId =
  | "KOSPI"
  | "KOSDAQ"
  | "KONEX"
  | "NASDAQ"
  | "NYSE"
  | "AMEX";

export type InstrumentSyncFormat =
  | "text"
  | "kr-mst-zip"
  | "nasdaq-listed"
  | "other-listed-nyse"
  | "other-listed-amex";

export type InstrumentSyncSource = {
  id: InstrumentSyncSourceId;
  country: "KR" | "US";
  market: string;
  /** file: path, url: http(s), or inline text via `body` */
  input: {
    kind: "file" | "url" | "inline";
    path?: string;
    url?: string;
    body?: string;
    /** Binary path for zip masters (when kind=file). */
    format?: InstrumentSyncFormat;
  };
  /** When true, apply fixture-friendly floors (tiny samples OK). */
  fixture?: boolean;
};

/** Absolute sanity floors for production masters (conservative vs current market size). */
export const PRODUCTION_MASTER_FLOORS: Record<InstrumentSyncSourceId, number> = {
  KOSPI: 800,
  KOSDAQ: 800,
  KONEX: 30,
  NASDAQ: 2000,
  NYSE: 1000,
  AMEX: 50,
};

/** Official production master URLs (KRX via Daishin DWS + NASDAQ Trader). */
export const PRODUCTION_MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
  KONEX: "https://new.real.download.dws.co.kr/common/master/konex_code.mst.zip",
  NASDAQ: "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
  OTHER: "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
} as const;

/**
 * Map parser/API alias types onto adopted RDS `ck_instrument_alias_type`
 * (SYMBOL | KOREAN | ENGLISH | SEARCH).
 */
export function toDbAliasType(aliasType: string): "SYMBOL" | "KOREAN" | "ENGLISH" | "SEARCH" {
  switch (aliasType) {
    case "SYMBOL":
    case "KOREAN":
    case "ENGLISH":
    case "SEARCH":
      return aliasType;
    case "ISIN":
      return "SEARCH";
    case "ENGLISH_NAME":
      return "ENGLISH";
    case "KOREAN_NAME":
      return "KOREAN";
    default:
      return "SEARCH";
  }
}

/**
 * Map sync result statuses onto adopted RDS `ck_instrument_sync_status`
 * (RUNNING | PASS | FAIL | DEGRADED). Result objects keep SUCCESS/FAILED for callers.
 */
export function toDbSyncRunStatus(
  status: "SUCCESS" | "FAILED" | "SKIPPED" | "RUNNING" | "PASS" | "FAIL" | "DEGRADED",
): "RUNNING" | "PASS" | "FAIL" | "DEGRADED" {
  switch (status) {
    case "SUCCESS":
    case "PASS":
      return "PASS";
    case "FAILED":
    case "FAIL":
      return "FAIL";
    case "SKIPPED":
    case "DEGRADED":
      return "DEGRADED";
    case "RUNNING":
      return "RUNNING";
    default:
      return "FAIL";
  }
}

export type InstrumentSyncRunResult = {
  source: string;
  country: string;
  market: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  totalCount: number;
  insertedCount: number;
  updatedCount: number;
  deactivatedCount: number;
  warnings: string[];
  error?: string;
  runId?: string;
};

export type MemoryInstrumentRecord = {
  id: string;
  country: string;
  market: string;
  symbol: string;
  displayName: string;
  koreanName: string | null;
  englishName: string | null;
  currency: string;
  kisExchangeCode: string | null;
  instrumentType: string;
  isActive: boolean;
  aliases: Array<{ id: string; alias: string; normalizedAlias: string; aliasType: string }>;
};

export type InstrumentSyncStore = {
  listActiveByMarket(country: string, market: string): Promise<MemoryInstrumentRecord[]>;
  applySourceBatch(args: {
    country: string;
    market: string;
    rows: ParsedMasterRow[];
  }): Promise<{ inserted: number; updated: number; deactivated: number }>;
  writeSyncRun(args: {
    id: string;
    country: string;
    source: string;
    status: string;
    totalCount: number;
    insertedCount: number;
    updatedCount: number;
    deactivatedCount: number;
    warningJson: unknown;
    startedAt: string;
    finishedAt: string | null;
  }): Promise<void>;
};

/** In-memory store for tests — source-isolated deactivate. */
export function createMemorySyncStore(
  seed: MemoryInstrumentRecord[] = [],
): InstrumentSyncStore & { records: Map<string, MemoryInstrumentRecord>; runs: unknown[] } {
  const records = new Map<string, MemoryInstrumentRecord>();
  for (const row of seed) records.set(row.id, structuredClone(row));
  const runs: unknown[] = [];

  return {
    records,
    runs,
    async listActiveByMarket(country, market) {
      return [...records.values()].filter(
        (row) => row.country === country && row.market === market && row.isActive,
      );
    },
    async applySourceBatch({ country, market, rows }) {
      let inserted = 0;
      let updated = 0;
      const present = new Set<string>();
      for (const row of rows) {
        const key = makeInstrumentKey(row.country, row.market, row.symbol);
        present.add(row.symbol);
        const id = stableId("instrument", key);
        const existing = records.get(id) ?? [...records.values()].find(
          (r) => r.country === row.country && r.market === row.market && r.symbol === row.symbol,
        );
        if (existing) {
          existing.displayName = row.displayName;
          existing.koreanName = row.koreanName ?? null;
          existing.englishName = row.englishName ?? null;
          existing.currency = row.currency;
          existing.kisExchangeCode = row.kisExchangeCode ?? null;
          existing.instrumentType = row.instrumentType;
          existing.isActive = true;
          existing.aliases = row.aliases.map((a) => ({
            id: stableId("alias", `${id}:${normalizeAlias(a.alias)}`),
            alias: a.alias,
            normalizedAlias: normalizeAlias(a.alias),
            aliasType: a.aliasType,
          }));
          records.set(existing.id, existing);
          updated++;
        } else {
          records.set(id, {
            id,
            country: row.country,
            market: row.market,
            symbol: row.symbol,
            displayName: row.displayName,
            koreanName: row.koreanName ?? null,
            englishName: row.englishName ?? null,
            currency: row.currency,
            kisExchangeCode: row.kisExchangeCode ?? null,
            instrumentType: row.instrumentType,
            isActive: true,
            aliases: row.aliases.map((a) => ({
              id: stableId("alias", `${id}:${normalizeAlias(a.alias)}`),
              alias: a.alias,
              normalizedAlias: normalizeAlias(a.alias),
              aliasType: a.aliasType,
            })),
          });
          inserted++;
        }
      }
      let deactivated = 0;
      for (const row of records.values()) {
        if (row.country !== country || row.market !== market) continue;
        if (!present.has(row.symbol) && row.isActive) {
          row.isActive = false;
          deactivated++;
        }
      }
      return { inserted, updated, deactivated };
    },
    async writeSyncRun(args) {
      runs.push(args);
    },
  };
}

export function createMysqlSyncStore(db: AppDb): InstrumentSyncStore {
  return {
    async listActiveByMarket(country, market) {
      const rows = await db
        .select()
        .from(schema.instruments)
        .where(
          and(
            eq(schema.instruments.country, country),
            eq(schema.instruments.market, market),
            eq(schema.instruments.isActive, true),
          ),
        );
      return rows.map((row) => ({
        id: row.id,
        country: row.country,
        market: row.market,
        symbol: row.symbol,
        displayName: row.displayName,
        koreanName: row.koreanName ?? null,
        englishName: row.englishName ?? null,
        currency: row.currency,
        kisExchangeCode: row.kisExchangeCode ?? null,
        instrumentType: row.instrumentType,
        isActive: Boolean(row.isActive),
        aliases: [],
      }));
    },
    async applySourceBatch({ country, market, rows }) {
      let inserted = 0;
      let updated = 0;
      let deactivated = 0;
      const symbols: string[] = [];

      await db.transaction(async (tx) => {
        for (const row of rows) {
          symbols.push(row.symbol);
          const key = makeInstrumentKey(row.country, row.market, row.symbol);
          const id = stableId("instrument", key);
          const existing = await tx
            .select({ id: schema.instruments.id })
            .from(schema.instruments)
            .where(
              and(
                eq(schema.instruments.country, row.country),
                eq(schema.instruments.market, row.market),
                eq(schema.instruments.symbol, row.symbol),
              ),
            )
            .limit(1);
          const isNew = existing.length === 0;
          await tx
            .insert(schema.instruments)
            .values({
              id,
              country: row.country,
              market: row.market,
              symbol: row.symbol,
              displayName: row.displayName,
              koreanName: row.koreanName ?? null,
              englishName: row.englishName ?? null,
              currency: row.currency,
              kisExchangeCode: row.kisExchangeCode ?? null,
              instrumentType: row.instrumentType,
              isActive: true,
              masterUpdatedAt: mysqlDateUtc(),
            })
            .onDuplicateKeyUpdate({
              set: {
                displayName: row.displayName,
                koreanName: row.koreanName ?? null,
                englishName: row.englishName ?? null,
                currency: row.currency,
                kisExchangeCode: row.kisExchangeCode ?? null,
                instrumentType: row.instrumentType,
                isActive: true,
                masterUpdatedAt: mysqlDateUtc(),
              },
            });
          if (isNew) inserted++;
          else updated++;

          const instrumentId = existing[0]?.id ?? id;
          for (const alias of row.aliases) {
            const normalizedAlias = normalizeAlias(alias.alias);
            if (!normalizedAlias) continue;
            const aliasType = toDbAliasType(alias.aliasType);
            await tx
              .insert(schema.instrumentAliases)
              .values({
                id: stableId("alias", `${instrumentId}:${normalizedAlias}`),
                instrumentId,
                alias: alias.alias,
                normalizedAlias,
                aliasType,
              })
              .onDuplicateKeyUpdate({
                set: { alias: alias.alias, aliasType },
              });
          }
        }

        // Source-isolated: only deactivate within this country+market.
        if (symbols.length > 0) {
          const doomed = await tx
            .select({ id: schema.instruments.id })
            .from(schema.instruments)
            .where(
              and(
                eq(schema.instruments.country, country),
                eq(schema.instruments.market, market),
                eq(schema.instruments.isActive, true),
                notInArray(schema.instruments.symbol, symbols),
              ),
            );
          deactivated = doomed.length;
          if (deactivated > 0) {
            await tx
              .update(schema.instruments)
              .set({ isActive: false, updatedAt: sql`CURRENT_TIMESTAMP(6)` })
              .where(
                and(
                  eq(schema.instruments.country, country),
                  eq(schema.instruments.market, market),
                  eq(schema.instruments.isActive, true),
                  notInArray(schema.instruments.symbol, symbols),
                ),
              );
          }
        }
      });

      return { inserted, updated, deactivated };
    },
    async writeSyncRun(args) {
      const status = toDbSyncRunStatus(args.status);
      await db
        .insert(schema.instrumentSyncRuns)
        .values({
          id: args.id,
          country: args.country,
          source: args.source,
          status,
          totalCount: args.totalCount,
          insertedCount: args.insertedCount,
          updatedCount: args.updatedCount,
          deactivatedCount: args.deactivatedCount,
          warningJson: args.warningJson,
          startedAt: args.startedAt,
          finishedAt: args.finishedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            status,
            totalCount: args.totalCount,
            insertedCount: args.insertedCount,
            updatedCount: args.updatedCount,
            deactivatedCount: args.deactivatedCount,
            warningJson: args.warningJson,
            finishedAt: args.finishedAt,
          },
        });
    },
  };
}

export async function downloadSourceBytes(
  input: InstrumentSyncSource["input"],
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  if (input.kind === "inline") {
    if (input.body == null) throw new Error("inline sync source missing body");
    return Buffer.from(input.body, "utf8");
  }
  if (input.kind === "file") {
    if (!input.path) throw new Error("file sync source missing path");
    return readFile(input.path);
  }
  if (!input.url) throw new Error("url sync source missing url");
  const res = await fetchImpl(input.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** @deprecated Prefer downloadSourceBytes — kept for text fixture callers. */
export async function downloadSourceText(
  input: InstrumentSyncSource["input"],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const buf = await downloadSourceBytes(input, fetchImpl);
  return buf.toString("utf8");
}

function unzipFirstEntry(buffer: Buffer): Buffer {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (!entries.length) throw new Error("zip master contains no files");
  const entry = entries[0]!;
  return entry.getData();
}

export function parseSourceBuffer(
  sourceId: InstrumentSyncSourceId,
  buffer: Buffer,
  format: InstrumentSyncFormat = "text",
): ParsedMasterRow[] {
  if (format === "kr-mst-zip") {
    const mst = unzipFirstEntry(buffer);
    if (sourceId === "KOSPI" || sourceId === "KOSDAQ" || sourceId === "KONEX") {
      return parseKrMstBinary(mst, sourceId);
    }
    throw new Error(`kr-mst-zip not valid for ${sourceId}`);
  }
  const text = buffer.toString("utf8");
  if (format === "nasdaq-listed") {
    if (sourceId !== "NASDAQ") throw new Error("nasdaq-listed format requires NASDAQ source");
    return parseNasdaqListed(text);
  }
  if (format === "other-listed-nyse") {
    if (sourceId !== "NYSE") throw new Error("other-listed-nyse requires NYSE source");
    return parseOtherListed(text).nyse;
  }
  if (format === "other-listed-amex") {
    if (sourceId !== "AMEX") throw new Error("other-listed-amex requires AMEX source");
    return parseOtherListed(text).amex;
  }
  return parseSourceText(sourceId, text);
}

export function parseSourceText(sourceId: InstrumentSyncSourceId, text: string): ParsedMasterRow[] {
  switch (sourceId) {
    case "KOSPI":
      return parseKrMaster(text, "KOSPI");
    case "KOSDAQ":
      return parseKrMaster(text, "KOSDAQ");
    case "KONEX":
      return parseKrMaster(text, "KONEX");
    case "NASDAQ":
      return parseUsMaster(text, "NASDAQ");
    case "NYSE":
      return parseUsMaster(text, "NYSE");
    case "AMEX":
      return parseUsMaster(text, "AMEX");
    default:
      throw new Error(`unsupported sync source: ${sourceId}`);
  }
}

export function validateParsedRows(
  sourceId: InstrumentSyncSourceId,
  rows: ParsedMasterRow[],
  opts: {
    fixture?: boolean;
    previousCount?: number;
  } = {},
): { ok: true; rows: ParsedMasterRow[] } | { ok: false; error: string } {
  if (rows.length === 0) {
    return { ok: false, error: `${sourceId} parse produced 0 rows — refusing to apply (no mass deactivate)` };
  }
  const expectedMarket = sourceId;
  const bad = rows.find((row) => row.market !== expectedMarket);
  if (bad) {
    return {
      ok: false,
      error: `${sourceId} contains foreign market row ${bad.market}:${bad.symbol}`,
    };
  }
  const seen = new Set<string>();
  const deduped: ParsedMasterRow[] = [];
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    if (!row.symbol || !row.displayName) {
      return { ok: false, error: `${sourceId} has incomplete row` };
    }
    deduped.push(row);
  }

  if (!opts.fixture) {
    const floor = PRODUCTION_MASTER_FLOORS[sourceId];
    if (deduped.length < floor) {
      return {
        ok: false,
        error: `${sourceId} count ${deduped.length} below production floor ${floor} — refusing to apply`,
      };
    }
  }

  const previous = opts.previousCount ?? 0;
  if (previous > 0 && deduped.length < previous * 0.5) {
    return {
      ok: false,
      error:
        `${sourceId} abnormal shrink ${previous} → ${deduped.length} (<50%) — existing DB untouched`,
    };
  }

  return { ok: true, rows: deduped };
}

/**
 * download → parse → validate → stage → transaction → apply.
 * Never delete-all on failure. Source-isolated (KOSDAQ fail does not touch KOSPI).
 */
export async function syncInstrumentSource(
  source: InstrumentSyncSource,
  options: {
    store?: InstrumentSyncStore;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<InstrumentSyncRunResult> {
  const startedAt = mysqlDateUtc();
  const runId = newId();
  const store = options.store ?? (getDb() ? createMysqlSyncStore(getDb()!) : null);
  const warnings: string[] = [];

  const fail = async (error: string): Promise<InstrumentSyncRunResult> => {
    const finishedAt = mysqlDateUtc();
    if (store) {
      await store.writeSyncRun({
        id: runId,
        country: source.country,
        source: source.id,
        status: "FAILED",
        totalCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        deactivatedCount: 0,
        warningJson: { warnings, error },
        startedAt,
        finishedAt,
      });
    }
    return {
      source: source.id,
      country: source.country,
      market: source.market,
      status: "FAILED",
      totalCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      deactivatedCount: 0,
      warnings,
      error,
      runId,
    };
  };

  if (!store) {
    return fail("Database unavailable — sync aborted without mutating instruments");
  }

  let buffer: Buffer;
  try {
    buffer = await downloadSourceBytes(source.input, options.fetchImpl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "download failed");
  }

  let parsed: ParsedMasterRow[];
  try {
    parsed = parseSourceBuffer(source.id, buffer, source.input.format ?? "text");
  } catch (err) {
    return fail(err instanceof Error ? err.message : "parse failed");
  }

  const before = await store.listActiveByMarket(source.country, source.market);
  const validated = validateParsedRows(source.id, parsed, {
    fixture: source.fixture === true,
    previousCount: before.length,
  });
  if (!validated.ok) return fail(validated.error);

  const beforeSymbols = new Set(before.map((r) => r.symbol));

  try {
    const { inserted, updated, deactivated } = await store.applySourceBatch({
      country: source.country,
      market: source.market,
      rows: validated.rows,
    });
    // Prefer precise deactivate count from pre-snapshot when MySQL returns 0.
    const present = new Set(validated.rows.map((r) => r.symbol));
    const deactivatedPrecise = [...beforeSymbols].filter((s) => !present.has(s)).length;
    const deactivatedCount = Math.max(deactivated, deactivatedPrecise);
    const finishedAt = mysqlDateUtc();
    await store.writeSyncRun({
      id: runId,
      country: source.country,
      source: source.id,
      status: "SUCCESS",
      totalCount: validated.rows.length,
      insertedCount: inserted,
      updatedCount: updated,
      deactivatedCount,
      warningJson: warnings.length ? { warnings } : null,
      startedAt,
      finishedAt,
    });
    return {
      source: source.id,
      country: source.country,
      market: source.market,
      status: "SUCCESS",
      totalCount: validated.rows.length,
      insertedCount: inserted,
      updatedCount: updated,
      deactivatedCount,
      warnings,
      runId,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "apply failed");
  }
}

export async function syncInstrumentSources(
  sources: InstrumentSyncSource[],
  options: { store?: InstrumentSyncStore; fetchImpl?: typeof fetch } = {},
): Promise<InstrumentSyncRunResult[]> {
  const results: InstrumentSyncRunResult[] = [];
  for (const source of sources) {
    // Sequential + isolated: one failure must not abort other sources' attempts,
    // and must not share a delete-all transaction across markets.
    results.push(await syncInstrumentSource(source, options));
  }
  return results;
}

export function fixtureSyncSources(fixturesDir: string): InstrumentSyncSource[] {
  return [
    { id: "KOSPI", country: "KR", market: "KOSPI", fixture: true, input: { kind: "file", path: `${fixturesDir}/kospi-sample.txt` } },
    { id: "KOSDAQ", country: "KR", market: "KOSDAQ", fixture: true, input: { kind: "file", path: `${fixturesDir}/kosdaq-sample.txt` } },
    { id: "KONEX", country: "KR", market: "KONEX", fixture: true, input: { kind: "file", path: `${fixturesDir}/konex-sample.txt` } },
    { id: "NASDAQ", country: "US", market: "NASDAQ", fixture: true, input: { kind: "file", path: `${fixturesDir}/nasdaq-sample.csv` } },
    { id: "NYSE", country: "US", market: "NYSE", fixture: true, input: { kind: "file", path: `${fixturesDir}/nyse-sample.csv` } },
    { id: "AMEX", country: "US", market: "AMEX", fixture: true, input: { kind: "file", path: `${fixturesDir}/amex-sample.csv` } },
  ];
}

/** Production KR+US full masters — never fixtures. */
export function productionSyncSources(env: NodeJS.ProcessEnv = process.env): InstrumentSyncSource[] {
  const kospi = env.INSTRUMENTS_KOSPI_URL?.trim() || PRODUCTION_MASTER_URLS.KOSPI;
  const kosdaq = env.INSTRUMENTS_KOSDAQ_URL?.trim() || PRODUCTION_MASTER_URLS.KOSDAQ;
  const konex = env.INSTRUMENTS_KONEX_URL?.trim() || PRODUCTION_MASTER_URLS.KONEX;
  const nasdaq = env.INSTRUMENTS_NASDAQ_URL?.trim() || PRODUCTION_MASTER_URLS.NASDAQ;
  const other = env.INSTRUMENTS_OTHER_LISTED_URL?.trim() || PRODUCTION_MASTER_URLS.OTHER;
  return [
    {
      id: "KOSPI",
      country: "KR",
      market: "KOSPI",
      input: { kind: "url", url: kospi, format: "kr-mst-zip" },
    },
    {
      id: "KOSDAQ",
      country: "KR",
      market: "KOSDAQ",
      input: { kind: "url", url: kosdaq, format: "kr-mst-zip" },
    },
    {
      id: "KONEX",
      country: "KR",
      market: "KONEX",
      input: { kind: "url", url: konex, format: "kr-mst-zip" },
    },
    {
      id: "NASDAQ",
      country: "US",
      market: "NASDAQ",
      input: { kind: "url", url: nasdaq, format: "nasdaq-listed" },
    },
    {
      id: "NYSE",
      country: "US",
      market: "NYSE",
      input: { kind: "url", url: other, format: "other-listed-nyse" },
    },
    {
      id: "AMEX",
      country: "US",
      market: "AMEX",
      input: { kind: "url", url: other, format: "other-listed-amex" },
    },
  ];
}

export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
