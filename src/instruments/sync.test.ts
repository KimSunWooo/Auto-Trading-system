import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createMemorySyncStore,
  syncInstrumentSource,
  validateParsedRows,
  type InstrumentSyncSource,
} from "@/src/instruments/sync";
import { parseKrMaster } from "@/src/instruments/parsers";
import { makeInstrumentKey } from "@/src/instruments/types";
import { stableId } from "@/src/db/ids";

const fixtures = path.join(process.cwd(), "src/instruments/fixtures");

function seedKospi(store: ReturnType<typeof createMemorySyncStore>) {
  const id = stableId("instrument", makeInstrumentKey("KR", "KOSPI", "005930"));
  store.records.set(id, {
    id,
    country: "KR",
    market: "KOSPI",
    symbol: "005930",
    displayName: "삼성전자",
    koreanName: "삼성전자",
    englishName: "Samsung Electronics",
    currency: "KRW",
    kisExchangeCode: "KRX",
    instrumentType: "STOCK",
    isActive: true,
    aliases: [],
  });
}

test("IM9: KOSDAQ sync failure does not mass-deactivate KOSPI", async () => {
  const store = createMemorySyncStore();
  seedKospi(store);

  const kosdaqFail: InstrumentSyncSource = {
    id: "KOSDAQ",
    country: "KR",
    market: "KOSDAQ",
    fixture: true,
    input: { kind: "inline", body: "this is not a valid master\n" },
  };

  const result = await syncInstrumentSource(kosdaqFail, { store });
  assert.equal(result.status, "FAILED");

  const kospi = [...store.records.values()].find((r) => r.symbol === "005930");
  assert.equal(kospi?.isActive, true);
  assert.equal(kospi?.market, "KOSPI");
});

test("IM10: empty parse refuses apply — no delete-all on failure", async () => {
  const store = createMemorySyncStore();
  seedKospi(store);
  // Also seed a KOSPI-only row that would disappear if delete-all ran.
  const extraId = stableId("instrument", makeInstrumentKey("KR", "KOSPI", "000660"));
  store.records.set(extraId, {
    id: extraId,
    country: "KR",
    market: "KOSPI",
    symbol: "000660",
    displayName: "SK하이닉스",
    koreanName: "SK하이닉스",
    englishName: null,
    currency: "KRW",
    kisExchangeCode: "KRX",
    instrumentType: "STOCK",
    isActive: true,
    aliases: [],
  });

  const emptyBody = "단축코드|표준코드|한글종목명|영문종목명|시장구분\n";
  const validated = validateParsedRows("KOSPI", parseKrMaster(emptyBody, "KOSPI"));
  assert.equal(validated.ok, false);

  const result = await syncInstrumentSource(
    { id: "KOSPI", country: "KR", market: "KOSPI", fixture: true, input: { kind: "inline", body: emptyBody } },
    { store },
  );
  assert.equal(result.status, "FAILED");
  assert.equal(store.records.get(extraId)?.isActive, true);
  assert.equal(
    [...store.records.values()].filter((r) => r.market === "KOSPI" && r.isActive).length,
    2,
  );
});

test("successful source-isolated sync deactivates only missing symbols in that market", async () => {
  const store = createMemorySyncStore();
  seedKospi(store);
  const staleKosdaqId = stableId("instrument", makeInstrumentKey("KR", "KOSDAQ", "999999"));
  store.records.set(staleKosdaqId, {
    id: staleKosdaqId,
    country: "KR",
    market: "KOSDAQ",
    symbol: "999999",
    displayName: "퇴출예정",
    koreanName: "퇴출예정",
    englishName: null,
    currency: "KRW",
    kisExchangeCode: "KRX",
    instrumentType: "STOCK",
    isActive: true,
    aliases: [],
  });

  const body = readFileSync(path.join(fixtures, "kosdaq-sample.txt"), "utf8");
  const result = await syncInstrumentSource(
    { id: "KOSDAQ", country: "KR", market: "KOSDAQ", fixture: true, input: { kind: "inline", body } },
    { store },
  );
  assert.equal(result.status, "SUCCESS");
  assert.ok(result.totalCount >= 3);
  assert.equal(store.records.get(staleKosdaqId)?.isActive, false);
  // KOSPI untouched
  assert.equal(
    [...store.records.values()].find((r) => r.symbol === "005930")?.isActive,
    true,
  );
  assert.ok(store.runs.some((r) => (r as { status: string }).status === "SUCCESS"));
});
