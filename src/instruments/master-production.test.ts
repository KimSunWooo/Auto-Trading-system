/**
 * M1–M12 instrument master production guards.
 * Network tests download official masters (read-only). No orders.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createMemorySyncStore,
  fixtureSyncSources,
  parseSourceBuffer,
  productionSyncSources,
  PRODUCTION_MASTER_FLOORS,
  syncInstrumentSource,
  validateParsedRows,
} from "@/src/instruments/sync";
import { searchInstrumentsDetailed } from "@/src/instruments/search";
import { parsedToRef } from "@/src/instruments/parsers";

const PROBE = "/tmp/master-probe";

test("M1 production sync does not use fixtures", () => {
  const prod = productionSyncSources();
  assert.ok(prod.length >= 6);
  for (const src of prod) {
    assert.equal(src.fixture, undefined);
    assert.equal(src.input.kind, "url");
    assert.ok(src.input.url && !src.input.url.includes("fixtures"));
    assert.ok(src.input.format && src.input.format !== "text");
  }
  const fixtures = fixtureSyncSources(path.join(process.cwd(), "src/instruments/fixtures"));
  assert.ok(fixtures.every((s) => s.fixture === true));
});

test("M2 KOSPI production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "kospi.zip"));
  const rows = parseSourceBuffer("KOSPI", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KOSPI);
  assert.ok(rows.some((r) => r.symbol === "005930" && /삼성/.test(r.displayName)));
  const validated = validateParsedRows("KOSPI", rows);
  assert.equal(validated.ok, true);
});

test("M3 KOSDAQ production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "kosdaq.zip"));
  const rows = parseSourceBuffer("KOSDAQ", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KOSDAQ);
  const validated = validateParsedRows("KOSDAQ", rows);
  assert.equal(validated.ok, true);
});

test("M4 KONEX production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "konex.zip"));
  const rows = parseSourceBuffer("KONEX", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KONEX);
  const validated = validateParsedRows("KONEX", rows);
  assert.equal(validated.ok, true);
});

test("M5 NASDAQ production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "nasdaqlisted.txt"));
  const rows = parseSourceBuffer("NASDAQ", buf, "nasdaq-listed");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.NASDAQ);
  assert.ok(rows.some((r) => r.symbol === "AAPL"));
  assert.equal(validateParsedRows("NASDAQ", rows).ok, true);
});

test("M6 NYSE production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "otherlisted.txt"));
  const rows = parseSourceBuffer("NYSE", buf, "other-listed-nyse");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.NYSE);
  assert.ok(rows.every((r) => r.market === "NYSE"));
  assert.equal(validateParsedRows("NYSE", rows).ok, true);
});

test("M7 AMEX production master parse", () => {
  const buf = readFileSync(path.join(PROBE, "otherlisted.txt"));
  const rows = parseSourceBuffer("AMEX", buf, "other-listed-amex");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.AMEX);
  assert.ok(rows.every((r) => r.market === "AMEX"));
  assert.equal(validateParsedRows("AMEX", rows).ok, true);
});

test("M8 abnormal count → reject", () => {
  const tiny = [
    {
      country: "KR",
      market: "KOSPI",
      symbol: "005930",
      displayName: "삼성전자",
      currency: "KRW",
      instrumentType: "STOCK",
      aliases: [],
    },
  ];
  const validated = validateParsedRows("KOSPI", tiny as never, { previousCount: 2000 });
  assert.equal(validated.ok, false);
  assert.match(String((validated as { error: string }).error), /abnormal shrink|floor/i);
});

test("M9 partial source fail preserves previous DB", async () => {
  const store = createMemorySyncStore();
  const id = "inst-kospi-keep";
  store.records.set(id, {
    id,
    country: "KR",
    market: "KOSPI",
    symbol: "005930",
    displayName: "삼성전자",
    koreanName: "삼성전자",
    englishName: null,
    currency: "KRW",
    kisExchangeCode: "KRX",
    instrumentType: "STOCK",
    isActive: true,
    aliases: [],
  });
  const fail = await syncInstrumentSource(
    {
      id: "KOSDAQ",
      country: "KR",
      market: "KOSDAQ",
      fixture: true,
      input: { kind: "inline", body: "" },
    },
    { store },
  );
  assert.equal(fail.status, "FAILED");
  assert.equal(store.records.get(id)?.isActive, true);
});

test("M10 no production seed fallback", async () => {
  const result = await searchInstrumentsDetailed(
    { q: "삼성전자", country: "KR" },
    { db: null },
  );
  assert.equal(result.catalogComplete, false);
  assert.equal(result.catalogSource, "none");
  assert.ok(result.error === "DB_UNAVAILABLE" || result.error === "CATALOG_NOT_READY");
  assert.equal(result.items.length, 0);
  assert.equal(result.kisCalls, 0);
});

test("M11 KR non-seed search", async () => {
  // Symbols unlikely in hardcoded UNIVERSE seed — present in full KOSPI master.
  const corpus = parseSourceBuffer(
    "KOSPI",
    readFileSync(path.join(PROBE, "kospi.zip")),
    "kr-mst-zip",
  )
    .filter((r) => ["000020", "000040", "000050"].includes(r.symbol))
    .map((r) => parsedToRef(r));
  assert.equal(corpus.length, 3);
  for (const sym of ["000020", "000040", "000050"]) {
    const hits = await searchInstrumentsDetailed(
      { q: sym, country: "KR" },
      { corpus },
    );
    assert.equal(hits.items[0]?.symbol, sym);
  }
});

test("M12 US non-seed search", async () => {
  const nasdaq = parseSourceBuffer(
    "NASDAQ",
    readFileSync(path.join(PROBE, "nasdaqlisted.txt")),
    "nasdaq-listed",
  );
  // Pick symbols that are not in the tiny US_SEED_UNIVERSE fixture set.
  const picks = nasdaq
    .map((r) => r.symbol)
    .filter((s) => !["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META"].includes(s))
    .slice(0, 3);
  assert.equal(picks.length, 3);
  const corpus = nasdaq
    .filter((r) => picks.includes(r.symbol))
    .map((r) => parsedToRef(r));
  for (const sym of picks) {
    const hits = await searchInstrumentsDetailed({ q: sym, country: "US" }, { corpus });
    assert.equal(hits.items[0]?.symbol, sym);
    assert.equal(hits.items[0]?.market, "NASDAQ");
  }
});
