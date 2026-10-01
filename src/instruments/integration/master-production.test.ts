/**
 * Production instrument master integration tests.
 *
 * Requires downloaded masters under INSTRUMENT_MASTER_PROBE_DIR (default /tmp/master-probe):
 *   kospi.zip, kosdaq.zip, konex.zip, nasdaqlisted.txt, otherlisted.txt
 *
 * Run (not part of default `npm test`):
 *   INSTRUMENT_MASTER_PROBE_DIR=/path/to/masters npm run test:instruments-production
 *
 * These tests assert PRODUCTION_MASTER_FLOORS and never skip when probe files are missing —
 * they fail closed with a clear setup error instead.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  parseSourceBuffer,
  PRODUCTION_MASTER_FLOORS,
  validateParsedRows,
} from "@/src/instruments/sync";
import { searchInstrumentsDetailed } from "@/src/instruments/search";
import { parsedToRef } from "@/src/instruments/parsers";

const PROBE =
  process.env.INSTRUMENT_MASTER_PROBE_DIR?.trim() || "/tmp/master-probe";

function requireProbe(name: string): Buffer {
  const file = path.join(PROBE, name);
  if (!existsSync(file)) {
    throw new Error(
      `Missing production master probe file: ${file}. ` +
        `Set INSTRUMENT_MASTER_PROBE_DIR and download KR/US masters, then re-run: npm run test:instruments-production`,
    );
  }
  return readFileSync(file);
}

test("PROD-M2 KOSPI production master parse", () => {
  const buf = requireProbe("kospi.zip");
  const rows = parseSourceBuffer("KOSPI", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KOSPI);
  assert.ok(rows.some((r) => r.symbol === "005930" && /삼성/.test(r.displayName)));
  const validated = validateParsedRows("KOSPI", rows);
  assert.equal(validated.ok, true);
});

test("PROD-M3 KOSDAQ production master parse", () => {
  const buf = requireProbe("kosdaq.zip");
  const rows = parseSourceBuffer("KOSDAQ", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KOSDAQ);
  const validated = validateParsedRows("KOSDAQ", rows);
  assert.equal(validated.ok, true);
});

test("PROD-M4 KONEX production master parse", () => {
  const buf = requireProbe("konex.zip");
  const rows = parseSourceBuffer("KONEX", buf, "kr-mst-zip");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.KONEX);
  const validated = validateParsedRows("KONEX", rows);
  assert.equal(validated.ok, true);
});

test("PROD-M5 NASDAQ production master parse", () => {
  const buf = requireProbe("nasdaqlisted.txt");
  const rows = parseSourceBuffer("NASDAQ", buf, "nasdaq-listed");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.NASDAQ);
  assert.ok(rows.some((r) => r.symbol === "AAPL"));
  assert.equal(validateParsedRows("NASDAQ", rows).ok, true);
});

test("PROD-M6 NYSE production master parse", () => {
  const buf = requireProbe("otherlisted.txt");
  const rows = parseSourceBuffer("NYSE", buf, "other-listed-nyse");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.NYSE);
  assert.ok(rows.every((r) => r.market === "NYSE"));
  assert.equal(validateParsedRows("NYSE", rows).ok, true);
});

test("PROD-M7 AMEX production master parse", () => {
  const buf = requireProbe("otherlisted.txt");
  const rows = parseSourceBuffer("AMEX", buf, "other-listed-amex");
  assert.ok(rows.length >= PRODUCTION_MASTER_FLOORS.AMEX);
  assert.ok(rows.every((r) => r.market === "AMEX"));
  assert.equal(validateParsedRows("AMEX", rows).ok, true);
});

test("PROD-M11 KR non-seed search against production corpus", async () => {
  const corpus = parseSourceBuffer("KOSPI", requireProbe("kospi.zip"), "kr-mst-zip")
    .filter((r) => ["000020", "000040", "000050"].includes(r.symbol))
    .map((r) => parsedToRef(r));
  assert.equal(corpus.length, 3);
  for (const sym of ["000020", "000040", "000050"]) {
    const hits = await searchInstrumentsDetailed({ q: sym, country: "KR" }, { corpus });
    assert.equal(hits.items[0]?.symbol, sym);
  }
});

test("PROD-M12 US non-seed search against production corpus", async () => {
  const nasdaq = parseSourceBuffer("NASDAQ", requireProbe("nasdaqlisted.txt"), "nasdaq-listed");
  const picks = nasdaq
    .map((r) => r.symbol)
    .filter((s) => !["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META"].includes(s))
    .slice(0, 3);
  assert.equal(picks.length, 3);
  const corpus = nasdaq.filter((r) => picks.includes(r.symbol)).map((r) => parsedToRef(r));
  for (const sym of picks) {
    const hits = await searchInstrumentsDetailed({ q: sym, country: "US" }, { corpus });
    assert.equal(hits.items[0]?.symbol, sym);
    assert.equal(hits.items[0]?.market, "NASDAQ");
  }
});
