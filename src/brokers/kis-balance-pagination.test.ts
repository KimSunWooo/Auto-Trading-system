import assert from "node:assert/strict";
import { test } from "node:test";
import { KisClient } from "@/src/brokers/kis-client";
import type { KisConfig } from "@/src/brokers/kis-config";

function paperCfg(): KisConfig {
  return {
    environment: "paper",
    mode: "paper",
    host: "https://openapivts.koreainvestment.com:29443",
    appKey: "k".repeat(20),
    appSecret: "s".repeat(20),
    cano: "50123456",
    productCode: "01",
    accountNo: "50123456-01",
    configured: true,
    liveEnabled: false,
    issues: [],
    tokenCacheKey: "test",
  } as KisConfig;
}

test("BV6 page cap + continuation token → FAIL", async () => {
  let page = 0;
  const fetchMock: typeof fetch = async () => {
    page += 1;
    return new Response(
      JSON.stringify({
        output1: [
          {
            pdno: String(100000 + page).slice(-6),
            hldg_qty: "1",
            pchs_avg_pric: "1000",
            prdt_name: `T${page}`,
          },
        ],
        output2: [{ dnca_tot_amt: "1000000", prvs_rcdl_excc_amt: "1000000" }],
        ctx_area_nk100: `NK${page}`,
        ctx_area_fk100: `FK${page}`,
      }),
      { status: 200 },
    );
  };
  // Token endpoint also hit — stub access token via first calls
  let calls = 0;
  const fetchAll: typeof fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    if (url.includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    return fetchMock(input, init);
  };
  const client = new KisClient(paperCfg(), fetchAll);
  await assert.rejects(() => client.inquireBalance(), /BALANCE_PAGINATION_INCOMPLETE/);
  assert.ok(page >= 10);
});

test("BV7 repeated continuation token → FAIL", async () => {
  const fetchAll: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        output1: [{ pdno: "005930", hldg_qty: "1", pchs_avg_pric: "70000", prdt_name: "삼성" }],
        output2: [{ dnca_tot_amt: "1000000", prvs_rcdl_excc_amt: "1000000" }],
        ctx_area_nk100: "SAME",
        ctx_area_fk100: "SAME",
      }),
      { status: 200 },
    );
  };
  const client = new KisClient(paperCfg(), fetchAll);
  await assert.rejects(() => client.inquireBalance(), /repeated continuation token/);
});
