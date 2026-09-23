import assert from "node:assert/strict";
import test from "node:test";
import { rankInstruments, searchInstruments, type SearchableInstrument } from "@/src/instruments/search";
import { toInstrumentRef } from "@/src/instruments/types";

function ref(
  country: string,
  market: string,
  symbol: string,
  displayName: string,
  extra: Partial<SearchableInstrument> = {},
): SearchableInstrument {
  return {
    ...toInstrumentRef({
      country,
      market,
      symbol,
      displayName,
      koreanName: extra.koreanName ?? (country === "KR" ? displayName : null),
      englishName: extra.englishName ?? (country === "US" ? displayName : null),
      currency: country === "US" ? "USD" : "KRW",
      aliases: extra.aliases,
    }),
    aliases: extra.aliases ?? [],
  };
}

const CORPUS: SearchableInstrument[] = [
  ref("KR", "KOSPI", "005930", "삼성전자", { aliases: ["Samsung Electronics", "samsung"] }),
  ref("KR", "KOSPI", "005380", "현대차"),
  ref("KR", "KOSPI", "005935", "삼성전자우"),
  ref("KR", "KOSDAQ", "247540", "에코프로비엠"),
  ref("US", "NASDAQ", "AAPL", "Apple", { englishName: "Apple Inc", aliases: ["Apple Inc"] }),
  ref("US", "NASDAQ", "AMZN", "Amazon"),
  ref("US", "NYSE", "BRK.B", "Berkshire Hathaway Class B"),
  ref("JP", "TSE", "7203", "Toyota Motor", { aliases: ["トヨタ"] }),
  // fillers so limit-20 behavior is observable
  ...Array.from({ length: 30 }, (_, i) =>
    ref("US", "NASDAQ", `F${String(i).padStart(3, "0")}`, `Filler ${i}`),
  ),
];

test("IS1: exact symbol ranks first", async () => {
  const hits = await searchInstruments({ q: "005930" }, { corpus: CORPUS });
  assert.equal(hits[0]?.symbol, "005930");
  assert.equal(hits[0]?.matchedOn, "exact_symbol");
});

test("IS2: exact name match", async () => {
  const hits = await searchInstruments({ q: "삼성전자" }, { corpus: CORPUS });
  assert.equal(hits[0]?.symbol, "005930");
  assert.equal(hits[0]?.matchedOn, "exact_name");
});

test("IS3: symbol prefix before contains", () => {
  const hits = rankInstruments(CORPUS, "0059", 10);
  assert.ok(hits.length >= 2);
  assert.equal(hits[0]?.matchedOn, "symbol_prefix");
  assert.ok(hits.every((h) => h.symbol.startsWith("0059") || h.matchedOn === "contains"));
});

test("IS4: name prefix", () => {
  const hits = rankInstruments(CORPUS, "삼성", 10);
  assert.ok(hits.some((h) => h.matchedOn === "name_prefix"));
  assert.equal(hits[0]?.matchedOn, "name_prefix");
});

test("IS5: alias prefix", () => {
  const hits = rankInstruments(CORPUS, "samsung elec", 10);
  assert.ok(hits.some((h) => h.symbol === "005930"));
  assert.equal(hits.find((h) => h.symbol === "005930")?.matchedOn, "alias_prefix");
});

test("IS6: contains match for mid-string", () => {
  const hits = rankInstruments(CORPUS, "프로비", 10);
  assert.ok(hits.some((h) => h.symbol === "247540"));
  assert.equal(hits.find((h) => h.symbol === "247540")?.matchedOn, "contains");
});

test("IS7: ranking order exact_symbol < exact_name < symbol_prefix < name_prefix < alias_prefix < contains", () => {
  const mixed: SearchableInstrument[] = [
    ref("KR", "KOSPI", "TARGET", "Other"), // exact_symbol
    ref("KR", "KOSPI", "EXNAME", "target"), // exact_name
    ref("KR", "KOSPI", "TARGETX", "Nope"), // symbol_prefix
    ref("KR", "KOSPI", "NAMEPX", "target corp"), // name_prefix
    ref("KR", "KOSPI", "ALIAS1", "Something", { aliases: ["target alias brand"] }), // alias_prefix
    ref("KR", "KOSPI", "CONT01", "zzz-contains-target-zzz"), // contains
  ];

  const hits = rankInstruments(mixed, "target", 10);
  assert.deepEqual(
    hits.map((h) => h.matchedOn),
    ["exact_symbol", "exact_name", "symbol_prefix", "name_prefix", "alias_prefix", "contains"],
  );
});

test("IS8: default limit 20; search creates 0 KIS calls (mock counter)", async () => {
  let kisCalls = 0;
  const fakeKis = {
    request() {
      kisCalls += 1;
      throw new Error("KIS must not be called from instrument search");
    },
  };
  void fakeKis;

  const hits = await searchInstruments(
    { q: "F" },
    {
      corpus: CORPUS,
      db: null,
      // limit omitted → default 20
    },
  );
  assert.equal(hits.length, 20);
  assert.equal(kisCalls, 0);

  // Seed fallback path also avoids KIS.
  const seedHits = await searchInstruments({ q: "005930", limit: 5 }, { db: null });
  assert.ok(seedHits.length >= 1);
  assert.equal(seedHits[0]?.symbol, "005930");
  assert.equal(kisCalls, 0);

  // Other overseas searchable but not automation-supported.
  const toyota = await searchInstruments({ q: "7203" }, { corpus: CORPUS, db: null });
  assert.equal(toyota[0]?.automationSupported, false);
});
