import assert from "node:assert/strict";
import test from "node:test";
import { KisClient, mapKisDailyCcldRow, resetKisTokenCacheForTest } from "./kis-client";
import { getKisConfig, KIS_HOSTS, KIS_LIVE_CONFIRM_VALUE, KIS_TR } from "./kis-config";

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

type Captured = { url: string; trId: string; method: string; body: Record<string, string> };

function mockOrderTransport(onOrder: (call: Captured) => void, realHttp: { count: number }) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("tokenP")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({
        access_token: body.appkey === "real-key" ? "real-token-value" : "paper-token-value",
        expires_in: 86_400,
      });
    }
    if (url.includes("/uapi/hashkey")) {
      return jsonResponse({ HASH: "hash-value" });
    }
    const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    onOrder({
      url,
      trId: headers.tr_id,
      method: String(init?.method ?? "GET"),
      body: parsedBody,
    });
    if (url.includes("order-rvsecncl")) {
      return jsonResponse({ rt_cd: "0", output: {} });
    }
    return jsonResponse({
      rt_cd: "0",
      output: { ODNO: "0000000042", KRX_FWDG_ORD_ORGNO: "06010" },
    });
  }) as typeof fetch;
}

test("PAPER cash buy uses VTTC0012U and official body including EXCG_ID_DVSN_CD=KRX", async () => {
  resetKisTokenCacheForTest();
  const realHttp = { count: 0 };
  const calls: Captured[] = [];
  const placed = await paperClient(mockOrderTransport((call) => calls.push(call), realHttp)).orderCash({
    ticker: "015760",
    side: "buy",
    qty: 1,
    ordDvsn: "limit",
    price: 8000,
  });
  assert.equal(placed.orderNo, "0000000042");
  assert.equal(placed.krxOrgNo, "06010");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.trId, "VTTC0012U");
  assert.ok(calls[0]!.url.startsWith(`${KIS_HOSTS.paper}/uapi/domestic-stock/v1/trading/order-cash`));
  assert.equal(calls[0]!.body.CANO, "11111111");
  assert.equal(calls[0]!.body.ACNT_PRDT_CD, "01");
  assert.equal(calls[0]!.body.PDNO, "015760");
  assert.equal(calls[0]!.body.ORD_DVSN, "00");
  assert.equal(calls[0]!.body.ORD_QTY, "1");
  assert.equal(calls[0]!.body.ORD_UNPR, "8000");
  assert.equal(calls[0]!.body.EXCG_ID_DVSN_CD, "KRX");
  assert.equal(realHttp.count, 0);
});

test("PAPER cash sell uses VTTC0011U", async () => {
  resetKisTokenCacheForTest();
  const realHttp = { count: 0 };
  const calls: Captured[] = [];
  await paperClient(mockOrderTransport((call) => calls.push(call), realHttp)).orderCash({
    ticker: "015760",
    side: "sell",
    qty: 1,
    ordDvsn: "limit",
    price: 8000,
  });
  assert.equal(calls[0]!.trId, "VTTC0011U");
  assert.equal(realHttp.count, 0);
});

test("REAL cash/cancel TR ids are official latest and orderCash is blocked without live process flags", async () => {
  resetKisTokenCacheForTest();
  const realHttp = { count: 0 };
  const calls: Captured[] = [];
  const client = realClient(mockOrderTransport((call) => calls.push(call), realHttp));
  assert.equal(client.mode, "real");
  assert.equal(KIS_TR.buy[client.mode], "TTTC0012U");
  assert.equal(KIS_TR.sell[client.mode], "TTTC0011U");
  assert.equal(KIS_TR.cancel[client.mode], "TTTC0013U");
  await assert.rejects(
    () =>
      client.orderCash({
        ticker: "015760",
        side: "buy",
        qty: 1,
        ordDvsn: "limit",
        price: 8000,
      }),
    /실전 KIS 주문/,
  );
  await assert.rejects(
    () =>
      client.cancelOrder({
        orderNo: "42",
        krxOrgNo: "06010",
        ordDvsn: "limit",
      }),
    /실전 KIS 주문/,
  );
  assert.equal(calls.length, 0);
  assert.equal(realHttp.count, 0);
});

test("PAPER cancel uses VTTC0013U and the exact original ODNO", async () => {
  resetKisTokenCacheForTest();
  const realHttp = { count: 0 };
  const calls: Captured[] = [];
  await paperClient(mockOrderTransport((call) => calls.push(call), realHttp)).cancelOrder({
    orderNo: "42",
    krxOrgNo: "06010",
    ordDvsn: "limit",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.trId, "VTTC0013U");
  assert.ok(calls[0]!.url.startsWith(`${KIS_HOSTS.paper}/uapi/domestic-stock/v1/trading/order-rvsecncl`));
  assert.equal(calls[0]!.body.ORGN_ODNO, "0000000042");
  assert.equal(calls[0]!.body.KRX_FWDG_ORD_ORGNO, "06010");
  assert.equal(calls[0]!.body.RVSE_CNCL_DVSN_CD, "02");
  assert.equal(calls[0]!.body.QTY_ALL_ORD_YN, "Y");
  assert.equal(calls[0]!.body.EXCG_ID_DVSN_CD, "KRX");
  assert.equal(calls[0]!.body.ORD_DVSN, "00");
  assert.equal(realHttp.count, 0);
});

test("PAPER inquire-balance maps deposit cash and does not treat D+2 as orderable cash", async () => {
  resetKisTokenCacheForTest();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tokenP")) {
      return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.tr_id, "VTTC8434R");
    assert.ok(url.includes("/uapi/domestic-stock/v1/trading/inquire-balance"));
    assert.equal(url.includes("order-cash"), false);
    return jsonResponse({
      rt_cd: "0",
      output1: [{ pdno: "005930", hldg_qty: "1", pchs_avg_pric: "253500", prdt_name: "삼성전자" }],
      output2: {
        dnca_tot_amt: "10000000",
        nxdy_excc_amt: "9746470",
        prvs_rcdl_excc_amt: "9746470",
        thdt_buy_amt: "253500",
        thdt_tlex_amt: "38",
        bfdy_buy_amt: "0",
        bfdy_sll_amt: "0",
        thdt_sll_amt: "0",
        bfdy_tlex_amt: "0",
      },
    });
  }) as typeof fetch;
  const balance = await paperClient(fetchImpl).inquireBalance();
  assert.equal(balance.cash, 10_000_000);
  assert.equal(balance.d2Cash, 9_746_470);
  assert.equal(balance.thdtBuyAmt, 253_500);
  assert.equal(balance.thdtTlexAmt, 38);
  assert.equal(balance.holdings[0]?.qty, 1);
});

test("PAPER inquire-psbl-order is GET VTTC8908R and maps ord_psbl_cash", async () => {
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
    return jsonResponse({
      rt_cd: "0",
      output: {
        ord_psbl_cash: "9746462",
        nrcvb_buy_amt: "9740000",
        nrcvb_buy_qty: "38",
        max_buy_amt: "9746462",
        max_buy_qty: "38",
      },
    });
  }) as typeof fetch;
  const psbl = await paperClient(fetchImpl).inquirePsblOrder({ ticker: "005930", price: 253500 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.trId, "VTTC8908R");
  assert.ok(calls[0]!.url.includes("/uapi/domestic-stock/v1/trading/inquire-psbl-order"));
  assert.equal(calls[0]!.url.includes("order-cash"), false);
  assert.equal(psbl.orderableCash, 9_746_462);
  assert.equal(psbl.nrcvbBuyAmt, 9_740_000);
  assert.equal(psbl.nrcvbBuyQty, 38);
  assert.equal(psbl.maxBuyAmt, 9_746_462);
  assert.equal(psbl.maxBuyQty, 38);
});

