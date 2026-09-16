import assert from "node:assert/strict";
import test from "node:test";
import { KisClient, mapKisDailyCcldRow, resetKisTokenCacheForTest } from "./kis-client";
import { getKisConfig, KIS_HOSTS, KIS_LIVE_CONFIRM_VALUE } from "./kis-config";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

test("paper and real access tokens are cached under separate keys", async () => {
  resetKisTokenCacheForTest();
  const tokenHosts: string[] = [];
  const appKeys: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.appkey) appKeys.push(headers.appkey);
    if (url.includes("tokenP")) {
      tokenHosts.push(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      if (body.appkey) appKeys.push(body.appkey);
      return jsonResponse({
        access_token: body.appkey === "paper-key" ? "paper-token-value" : "real-token-value",
        expires_in: 86_400,
      });
    }
    return jsonResponse({
      rt_cd: "0",
      output: {
        stck_prpr: "70000",
        hts_kor_isnm: "삼성전자",
        stck_oprc: "70000",
        stck_hgpr: "71000",
        stck_lwpr: "69000",
        stck_sdpr: "69500",
        acml_vol: "1",
      },
    });
  }) as typeof fetch;

  const paper = new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: "paper-key",
      KIS_PAPER_APP_SECRET: "paper-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
    fetchImpl,
  );
  const real = new KisClient(
    getKisConfig("real", {
      KIS_REAL_APP_KEY: "real-key",
      KIS_REAL_APP_SECRET: "real-secret",
      KIS_REAL_ACCOUNT_NO: "22222222-01",
      KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
      TRADING_MODE: "live",
      ALLOW_LIVE_TRADING: "true",
    }),
    fetchImpl,
  );

  await paper.inquirePrice("005930");
  await real.inquirePrice("005930");

  assert.equal(paper.tokenCacheKey, "kis:token:paper");
  assert.equal(real.tokenCacheKey, "kis:token:real");
  assert.ok(tokenHosts.some((url) => url.startsWith(KIS_HOSTS.paper)));
  assert.ok(tokenHosts.some((url) => url.startsWith(KIS_HOSTS.real)));
  assert.ok(appKeys.includes("paper-key"));
  assert.ok(appKeys.includes("real-key"));
  assert.equal(
    appKeys.includes("paper-key") && appKeys.includes("real-key"),
    true,
  );
});

test("mapKisDailyCcldRow maps ODNO, remaining qty, and partial fills exactly", () => {
  const mapped = mapKisDailyCcldRow({
    odno: "0000123456",
    pdno: "005930",
    sll_buy_dvsn_cd: "02",
    ord_qty: "10",
    tot_ccld_qty: "4",
    rmn_qty: "6",
    ord_unpr: "70000",
    avg_prvs: "70100",
    ord_dt: "20260916",
    ord_tmd: "093015",
    cncl_yn: "N",
  });
  assert.deepEqual(mapped, {
    orderNo: "0000123456",
    ticker: "005930",
    side: "buy",
    qty: 10,
    filledQty: 4,
    unfilledQty: 6,
    avgPrice: 70100,
    orderPrice: 70000,
    ordDt: "20260916",
    ordTmd: "093015",
    cnclYn: "N",
  });
  assert.equal(mapped?.unfilledQty, 6);
  assert.notEqual(mapped?.unfilledQty, 10);
});

test("mapKisDailyCcldRow treats empty output as no row", () => {
  assert.equal(mapKisDailyCcldRow({}), null);
});

function paperClient(fetchImpl: typeof fetch) {
  return new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: "paper-key",
      KIS_PAPER_APP_SECRET: "paper-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
    fetchImpl,
  );
}

function realClient(fetchImpl: typeof fetch) {
  return new KisClient(
    getKisConfig("real", {
      KIS_REAL_APP_KEY: "real-key",
      KIS_REAL_APP_SECRET: "real-secret",
      KIS_REAL_ACCOUNT_NO: "22222222-01",
      KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
      TRADING_MODE: "live",
      ALLOW_LIVE_TRADING: "true",
    }),
    fetchImpl,
  );
}

test("PAPER open orders uses domestic inquire-daily-ccld with VTTC0081R and CCLD_DVSN=02", async () => {
  resetKisTokenCacheForTest();
  const calls: Array<{ url: string; trId: string; method: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = String(init?.method ?? "GET");
    if (url.includes("tokenP")) {
      return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    }
    calls.push({ url, trId: headers.tr_id, method });
    return jsonResponse({ rt_cd: "0", output1: [] });
  }) as typeof fetch;

  const rows = await paperClient(fetchImpl).inquireOpenOrders();
  assert.equal(rows.length, 0);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, "GET");
  assert.ok(call.url.startsWith(`${KIS_HOSTS.paper}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`));
  assert.equal(call.url.includes("inquire-nccs"), false);
  assert.equal(call.url.includes("overseas-stock"), false);
  assert.equal(call.trId, "VTTC0081R");
  const parsed = new URL(call.url);
  assert.equal(parsed.searchParams.get("CCLD_DVSN"), "02");
  assert.equal(parsed.searchParams.get("CANO"), "11111111");
  assert.equal(parsed.searchParams.get("ACNT_PRDT_CD"), "01");
  assert.equal(parsed.searchParams.get("SLL_BUY_DVSN_CD"), "00");
  assert.equal(call.url.includes("order-cash"), false);
});

test("PAPER executions uses domestic inquire-daily-ccld with VTTC0081R and CCLD_DVSN=01", async () => {
  resetKisTokenCacheForTest();
  const calls: Array<{ url: string; trId: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("tokenP")) {
      return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    }
    calls.push({ url, trId: headers.tr_id });
    return jsonResponse({ rt_cd: "0", output1: [] });
  }) as typeof fetch;

  const rows = await paperClient(fetchImpl).inquireDailyCcld();
  assert.equal(rows.length, 0);
  assert.equal(calls[0]!.trId, "VTTC0081R");
  assert.ok(calls[0]!.url.startsWith(`${KIS_HOSTS.paper}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`));
  assert.equal(new URL(calls[0]!.url).searchParams.get("CCLD_DVSN"), "01");
});

test("REAL open orders stay on REAL host and TTTC0081R", async () => {
  resetKisTokenCacheForTest();
  const calls: Array<{ url: string; trId: string; appkey: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("tokenP")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({
        access_token: body.appkey === "real-key" ? "real-token-value" : "wrong",
        expires_in: 86_400,
      });
    }
    calls.push({ url, trId: headers.tr_id, appkey: headers.appkey });
    return jsonResponse({ rt_cd: "0", output1: [] });
  }) as typeof fetch;

  await realClient(fetchImpl).inquireOpenOrders();
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.startsWith(`${KIS_HOSTS.real}/uapi/domestic-stock/v1/trading/inquire-daily-ccld`));
  assert.equal(calls[0]!.url.includes(KIS_HOSTS.paper), false);
  assert.equal(calls[0]!.trId, "TTTC0081R");
  assert.equal(calls[0]!.appkey, "real-key");
});

test("open-order query does not submit or cancel orders", async () => {
  resetKisTokenCacheForTest();
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("tokenP")) {
      return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    }
    return jsonResponse({
      rt_cd: "0",
      output1: [
        {
          odno: "42",
          pdno: "005930",
          sll_buy_dvsn_cd: "02",
          ord_qty: "3",
          tot_ccld_qty: "1",
          rmn_qty: "2",
          ord_unpr: "70000",
          cncl_yn: "N",
        },
      ],
    });
  }) as typeof fetch;

  const rows = await paperClient(fetchImpl).inquireOpenOrders();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.orderNo, "42");
  assert.equal(rows[0]!.unfilledQty, 2);
  assert.equal(rows[0]!.filledQty, 1);
  assert.equal(
    urls.some((url) => url.includes("order-cash") || url.includes("order-rvsecncl")),
    false,
  );
});
