import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  formatInstrumentLabel,
  instrumentNameCacheSizeForTest,
  instrumentNameOnly,
  resetInstrumentNameCacheForTest,
  resolveInstrumentMetadata,
} from "@/src/instruments/metadata";

afterEach(() => {
  resetInstrumentNameCacheForTest();
});

test("005930 → 삼성전자 without KIS call", () => {
  const meta = resolveInstrumentMetadata("005930");
  assert.equal(meta.symbol, "005930");
  assert.equal(meta.name, "삼성전자");
  assert.equal(instrumentNameOnly("005930"), "삼성전자");
  assert.equal(formatInstrumentLabel("005930"), "삼성전자 (005930)");
});

test("name unavailable falls back to symbol", () => {
  assert.equal(formatInstrumentLabel("ZZZZZZ"), "ZZZZZZ");
  assert.equal(resolveInstrumentMetadata("ZZZZZZ").name, null);
});

test("cache avoids repeated lookups inventing names", () => {
  resolveInstrumentMetadata("069500");
  const size = instrumentNameCacheSizeForTest();
  resolveInstrumentMetadata("069500");
  assert.equal(instrumentNameCacheSizeForTest(), size);
  assert.equal(formatInstrumentLabel("069500"), "KODEX 200 (069500)");
});
