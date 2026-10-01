/**
 * Default suite: instrument master guards using isolated fixtures.
 * Production zip/txt probe tests live in src/instruments/integration/
 * (`npm run test:instruments-production` after downloading masters to /tmp/master-probe).
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
  syncInstrumentSource,
  validateParsedRows,
} from "@/src/instruments/sync";
import { searchInstrumentsDetailed } from "@/src/instruments/search";
import { parsedToRef } from "@/src/instruments/parsers";

const FIXTURES = path.join(process.cwd(), "src/instruments/fixtures");

function readFixtureBuf(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

test("M1 production sync does not use fixtures", () => {
  const prod = productionSyncSources();
  assert.ok(prod.length >= 6);
  for (const src of prod) {
    assert.equal(src.fixture, undefined);
    assert.equal(src.input.kind, "url");
    assert.ok(src.input.url && !src.input.url.includes("fixtures"));
    assert.ok(src.input.format && src.input.format !== "text");
  }
  const fixtures = fixtureSyncSources(FIXTURES);
  assert.ok(fixtures.every((s) => s.fixture === true));
});

test("M2 KOSPI fixture master parse", () => {
  const rows = parseSourceBuffer("KOSPI", readFixtureBuf("kospi-sample.txt"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => r.symbol === "005930" && /삼성/.test(r.displayName)));
  const validated = validateParsedRows("KOSPI", rows, { fixture: true, previousCount: 0 });
  assert.equal(validated.ok, true);
  assert.ok(rows.every((r) => r.market === "KOSPI" && r.country === "KR"));
});

test("M3 KOSDAQ fixture master parse", () => {
  const rows = parseSourceBuffer("KOSDAQ", readFixtureBuf("kosdaq-sample.txt"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.market === "KOSDAQ"));
});

test("M4 KONEX fixture master parse", () => {
  const rows = parseSourceBuffer("KONEX", readFixtureBuf("konex-sample.txt"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.market === "KONEX"));
});

test("M5 NASDAQ fixture master parse", () => {
  const rows = parseSourceBuffer("NASDAQ", readFixtureBuf("nasdaq-sample.csv"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => r.symbol === "AAPL"));
});

test("M6 NYSE fixture master parse", () => {
  const rows = parseSourceBuffer("NYSE", readFixtureBuf("nyse-sample.csv"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.market === "NYSE"));
});

test("M7 AMEX fixture master parse", () => {
  const rows = parseSourceBuffer("AMEX", readFixtureBuf("amex-sample.csv"), "text");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.market === "AMEX"));
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

test("M11 KR fixture non-seed search", async () => {
  const corpus = parseSourceBuffer("KOSPI", readFixtureBuf("kospi-sample.txt"), "text")
    .filter((r) => ["005930", "069500"].includes(r.symbol) || r.symbol.length === 6)
    .map((r) => parsedToRef(r));
  assert.ok(corpus.length >= 1);
  const target = corpus.find((r) => r.symbol === "005930") ?? corpus[0]!;
  const hits = await searchInstrumentsDetailed(
    { q: target.symbol, country: "KR" },
    { corpus },
  );
  assert.equal(hits.items[0]?.symbol, target.symbol);
});

test("M12 US fixture non-seed search", async () => {
  const nasdaq = parseSourceBuffer("NASDAQ", readFixtureBuf("nasdaq-sample.csv"), "text");
  const picks = nasdaq.map((r) => r.symbol).filter(Boolean).slice(0, 3);
  assert.ok(picks.length >= 1);
  const corpus = nasdaq.filter((r) => picks.includes(r.symbol)).map((r) => parsedToRef(r));
  for (const sym of picks) {
    const hits = await searchInstrumentsDetailed({ q: sym, country: "US" }, { corpus });
    assert.equal(hits.items[0]?.symbol, sym);
    assert.equal(hits.items[0]?.market, "NASDAQ");
  }
});
