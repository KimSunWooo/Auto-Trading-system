import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeAlias, normalizeInstrumentText, normalizeSymbol } from "@/src/instruments/normalize";
import { parseKrMaster, parseUsMaster } from "@/src/instruments/parsers";
import { automationSupportedFor, makeInstrumentKey, toInstrumentRef } from "@/src/instruments/types";
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";

const fixtures = path.join(process.cwd(), "src/instruments/fixtures");

function readFixture(name: string): string {
  return readFileSync(path.join(fixtures, name), "utf8");
}

test("IM1: KOSPI pipe fixture parses Samsung and KODEX", () => {
  const rows = parseKrMaster(readFixture("kospi-sample.txt"), "KOSPI");
  assert.ok(rows.length >= 4);
  const samsung = rows.find((r) => r.symbol === "005930");
  assert.equal(samsung?.market, "KOSPI");
  assert.equal(samsung?.country, "KR");
  assert.match(samsung?.displayName ?? "", /삼성전자/);
  assert.equal(samsung?.currency, "KRW");
});

test("IM2: KOSDAQ TSV fixture parses EcoPro BM", () => {
  const rows = parseKrMaster(readFixture("kosdaq-sample.txt"), "KOSDAQ");
  const eco = rows.find((r) => r.symbol === "247540");
  assert.equal(eco?.market, "KOSDAQ");
  assert.match(eco?.displayName ?? "", /에코프로비엠/);
});

test("IM3: KONEX pipe fixture stays market-isolated", () => {
  const rows = parseKrMaster(readFixture("konex-sample.txt"), "KONEX");
  assert.ok(rows.every((r) => r.market === "KONEX"));
  assert.ok(rows.some((r) => r.symbol === "900110"));
});

test("IM4: NASDAQ CSV fixture parses AAPL", () => {
  const rows = parseUsMaster(readFixture("nasdaq-sample.csv"), "NASDAQ");
  const aapl = rows.find((r) => r.symbol === "AAPL");
  assert.equal(aapl?.market, "NASDAQ");
  assert.equal(aapl?.currency, "USD");
  assert.match(aapl?.displayName ?? "", /Apple/i);
});

test("IM5: NYSE keeps BRK.B punctuation", () => {
  const rows = parseUsMaster(readFixture("nyse-sample.csv"), "NYSE");
  const brk = rows.find((r) => r.symbol === "BRK.B");
  assert.ok(brk, "BRK.B must survive parse");
  assert.equal(brk?.symbol, "BRK.B");
  assert.equal(normalizeSymbol("BRK.B"), "brk.b");
});

test("IM6: AMEX marks ETF type for SPY", () => {
  const rows = parseUsMaster(readFixture("amex-sample.csv"), "AMEX");
  const spy = rows.find((r) => r.symbol === "SPY");
  assert.equal(spy?.instrumentType, "ETF");
  assert.equal(spy?.market, "AMEX");
});

test("IM7: automationSupported only for KR KOSPI/KOSDAQ/KONEX and US NASDAQ/NYSE/AMEX", () => {
  assert.equal(automationSupportedFor("KR", "KOSPI"), true);
  assert.equal(automationSupportedFor("KR", "KOSDAQ"), true);
  assert.equal(automationSupportedFor("KR", "KONEX"), true);
  assert.equal(automationSupportedFor("US", "NASDAQ"), true);
  assert.equal(automationSupportedFor("US", "NYSE"), true);
  assert.equal(automationSupportedFor("US", "AMEX"), true);
  assert.equal(automationSupportedFor("JP", "TSE"), false);
  assert.equal(automationSupportedFor("HK", "HKEX"), false);
  const other = toInstrumentRef({
    country: "JP",
    market: "TSE",
    symbol: "7203",
    displayName: "Toyota",
    currency: "JPY",
  });
  assert.equal(other.automationSupported, false);
  assert.equal(other.instrumentKey, "JP:TSE:7203");
});

test("IM8: normalize NFKC, trim, whitespace collapse, EN case fold; keep punctuation", () => {
  assert.equal(normalizeInstrumentText("  Samsung   Electronics "), "samsung electronics");
  assert.equal(normalizeInstrumentText("ＡＡＰＬ"), "aapl"); // NFKC fullwidth
  assert.equal(normalizeSymbol(" Brk.B "), "brk.b");
  assert.equal(normalizeAlias("  NAVER  "), "naver");
  assert.equal(makeInstrumentKey("kr", "kospi", "005930"), "KR:KOSPI:005930");
});

test("dashboard representatives stay in config module (KR5 + US5)", () => {
  const all = configDashboardRepresentatives();
  assert.equal(all.filter((r) => r.country === "KR").length, 5);
  assert.equal(all.filter((r) => r.country === "US").length, 5);
  assert.ok(all.some((r) => r.symbol === "005930"));
  assert.ok(all.some((r) => r.symbol === "AAPL"));
});
