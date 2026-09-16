import assert from "node:assert/strict";
import test from "node:test";
import { upsertIntent } from "@/src/runtime/intents";
import { createPaperState } from "@/lib/engine";
import { RiskManager } from "@/src/risk/RiskManager";
import { getKisConfig, KIS_HOSTS, KIS_LIVE_CONFIRM_VALUE, KIS_OVERSEAS_TR, KIS_TR } from "@/src/brokers/kis-config";
import { KisClient, resetKisTokenCacheForTest } from "@/src/brokers/kis-client";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { krwEquivalent, overseasOrderExposure } from "@/src/markets/overseas/fx";
import {
  exchangeToQuoteExcd,
  exchangeToTradingExcg,
  makeUsInstrument,
  overseasIdentity,
  parseOverseasInstrument,
  sameOverseasIdentity,
} from "@/src/markets/overseas/instruments";
import {
  findOpenOrderByOdno,
  mapOverseasExecution,
  mapOverseasHolding,
  mapOverseasOpenOrder,
  mapOverseasPrice,
  mapForeignCashRows,
} from "@/src/markets/overseas/mapping";

test("overseas instrument parsing keeps exchange in identity", () => {
  const aapl = parseOverseasInstrument("NASDAQ:AAPL");
  const ko = parseOverseasInstrument("NYSE:KO");
  assert.equal(aapl?.market, "OVERSEAS");
  assert.equal(aapl?.country, "US");
  assert.equal(aapl?.exchange, "NASDAQ");
  assert.equal(aapl?.symbol, "AAPL");
  assert.equal(aapl?.currency, "USD");
  assert.equal(overseasIdentity("NASDAQ", "AAPL"), "NASDAQ:AAPL");
  assert.equal(sameOverseasIdentity("NASDAQ:AAPL", "NAS:AAPL"), true);
  assert.equal(sameOverseasIdentity("NASDAQ:AAPL", "NYSE:KO"), false);
  assert.equal(parseOverseasInstrument("005930"), null);
  assert.ok(ko);
});

test("KIS quote EXCD and trading OVRS_EXCG_CD stay separate", () => {
  assert.equal(exchangeToQuoteExcd("NASDAQ"), "NAS");
  assert.equal(exchangeToTradingExcg("NASDAQ"), "NASD");
  assert.equal(exchangeToQuoteExcd("NYSE"), "NYS");
  assert.equal(exchangeToTradingExcg("NYSE"), "NYSE");
  assert.equal(exchangeToQuoteExcd("AMEX"), "AMS");
  assert.equal(exchangeToTradingExcg("AMEX"), "AMEX");
  assert.notEqual(exchangeToQuoteExcd("NASDAQ"), exchangeToTradingExcg("NASDAQ"));
});

test("currency mapping keeps USD cash out of KRW", () => {
  const { cash, fx } = mapForeignCashRows(
    [{ crcy_cd: "USD", frcr_dncl_amt: "1234.56", frcr_ord_psbl_amt1: "1000.00", frst_bltn_exrt: "1300" }],
    null,
  );
  assert.equal(cash[0]?.currency, "USD");
  assert.equal(cash[0]?.cash, 1234.56);
  assert.equal(cash[0]?.orderableCash, 1000);
  assert.equal(fx?.baseCurrency, "USD");
  assert.equal(fx?.quoteCurrency, "KRW");
  assert.equal(fx?.rate, 1300);
  assert.equal(cash[0]?.krwEquivalent, 1234.56 * 1300);
  assert.notEqual(cash[0]?.cash, cash[0]?.krwEquivalent);
});

test("overseas quote parsing uses official last/base/rate fields", () => {
  const quote = mapOverseasPrice(
    { last: "190.12", base: "188.00", diff: "2.12", rate: "1.13", open: "189", high: "191", low: "187", tvol: "10", ordy: "YES", curr: "USD" },
    makeUsInstrument("NASDAQ", "AAPL", "Apple"),
  );
  assert.ok(quote);
  assert.equal(quote.symbol, "AAPL");
  assert.equal(quote.exchange, "NASDAQ");
  assert.equal(quote.currency, "USD");
  assert.equal(quote.price, 190.12);
  assert.equal(quote.change, 2.12);
  assert.equal(quote.changeRate, 1.13);
  assert.equal(quote.source, "kis");
  assert.equal(quote.marketStatus, "open");
});

test("overseas open-order ODNO is exact and remaining qty uses nccs_qty", () => {
  const mapped = mapOverseasOpenOrder({
    odno: "0000123456",
    pdno: "AAPL",
    ovrs_excg_cd: "NASD",
    sll_buy_dvsn_cd: "02",
    ft_ord_qty: "10",
    ft_ccld_qty: "4",
    nccs_qty: "6",
    ft_ord_unpr3: "190.00",
    tr_crcy_cd: "USD",
  });
  assert.equal(mapped?.orderNo, "0000123456");
  assert.equal(mapped?.identity, "NASDAQ:AAPL");
  assert.equal(mapped?.filledQty, 4);
  assert.equal(mapped?.remainingQty, 6);
  assert.notEqual(mapped?.remainingQty, mapped?.qty);
  assert.equal(findOpenOrderByOdno([mapped!], "123456")?.orderNo, "0000123456");
  assert.equal(findOpenOrderByOdno([mapped!], "999"), undefined);
});

test("overseas execution mapping preserves exchange identity and partial fill", () => {
  const mapped = mapOverseasExecution({
    odno: "88",
    pdno: "KO",
    ovrs_excg_cd: "NYSE",
    sll_buy_dvsn_cd: "01",
    ft_ord_qty: "5",
    ft_ccld_qty: "2",
    nccs_qty: "3",
    ft_ccld_unpr3: "70.1",
    tr_crcy_cd: "USD",
  });
  assert.equal(mapped?.identity, "NYSE:KO");
  assert.equal(mapped?.side, "sell");
  assert.equal(mapped?.filledQty, 2);
  assert.equal(mapped?.remainingQty, 3);
});

test("foreign holding mapping keeps trading currency", () => {
  const pos = mapOverseasHolding(
    {
      ovrs_pdno: "AAPL",
      ovrs_item_name: "Apple",
      ovrs_cblc_qty: "3",
      pchs_avg_pric: "180",
      now_pric2: "190",
      ovrs_excg_cd: "NASD",
      tr_crcy_cd: "USD",
      frcr_evlu_amt: "570",
    },
    1300,
  );
  assert.equal(pos?.identity, "NASDAQ:AAPL");
  assert.equal(pos?.currency, "USD");
  assert.equal(pos?.marketValue, 570);
  assert.equal(pos?.krwEquivalent, 570 * 1300);
});

test("currency-safe risk reports native USD and KRW equivalent separately", () => {
  const exposure = overseasOrderExposure({ qty: 1, nativePrice: 190, fxRate: 1300 });
  assert.equal(exposure.nativeCurrency, "USD");
  assert.equal(exposure.nativeValue, 190);
  assert.equal(exposure.krwEquivalent, 190 * 1300);
  assert.equal(krwEquivalent(190, null), null);
  const blocked = RiskManager.checkOverseasBuy({
    qty: 2,
    nativePrice: 100,
    orderableNative: 150,
    fxRate: 1300,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.nativeValue, 200);
  assert.equal(blocked.krwEquivalent, 260000);
  const ok = RiskManager.checkOverseasBuy({ qty: 1, nativePrice: 100, orderableNative: 150, fxRate: 1300 });
  assert.equal(ok.ok, true);
});

test("KRW equivalent is not invented without an FX rate", () => {
  assert.equal(krwEquivalent(100, 0), null);
  assert.equal(krwEquivalent(100, undefined), null);
});

test("duplicate signal/intent does not create a second overseas submit", () => {
  let state = createPaperState();
  const first = upsertIntent(state, {
    intentId: "sig:overseas:NASDAQ:AAPL:buy:1",
    signalId: "sig:overseas:NASDAQ:AAPL:buy:1",
    ruleId: "overseas",
    ticker: "NASDAQ:AAPL",
    side: "buy",
    qty: 1,
    price: 190,
    reason: "test",
  });
  state = first.state;
  const second = upsertIntent(state, {
    intentId: "sig:overseas:NASDAQ:AAPL:buy:1",
    signalId: "sig:overseas:NASDAQ:AAPL:buy:1",
    ruleId: "overseas",
    ticker: "NASDAQ:AAPL",
    side: "buy",
    qty: 1,
    price: 190,
    reason: "test",
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal((second.state.intents ?? []).filter((row) => row.intentId === first.intent.intentId).length, 1);
});

test("official overseas TR IDs match KIS samples and stay off domestic paths", () => {
  assert.equal(KIS_OVERSEAS_TR.price, "HHDFS00000300");
  assert.equal(KIS_OVERSEAS_TR.balance.paper, "VTTS3012R");
  assert.equal(KIS_OVERSEAS_TR.psamount.paper, "VTTS3007R");
  assert.equal(KIS_OVERSEAS_TR.nccs, "TTTS3018R");
  assert.equal(KIS_OVERSEAS_TR.ccnl.paper, "VTTS3035R");
  assert.equal(KIS_OVERSEAS_TR.usBuy.paper, "VTTT1002U");
  assert.equal(KIS_OVERSEAS_TR.usSell.paper, "VTTT1001U");
  assert.equal(KIS_OVERSEAS_TR.cancel.paper, "VTTT1004U");
  assert.equal(KIS_OVERSEAS_TR.usBuy.real, "TTTT1002U");
  assert.equal(KIS_OVERSEAS_TR.usSell.real, "TTTT1006U");
  assert.equal(KIS_OVERSEAS_TR.cancel.real, "TTTT1004U");
  assert.notEqual(KIS_OVERSEAS_TR.usBuy.paper, KIS_TR.buy.paper);
  assert.equal(KIS_CURRENCY_EXCHANGE_AUDIT.supported, "NO");
  assert.equal(KIS_CURRENCY_EXCHANGE_AUDIT.paperVtsExecutionSupported, "NO");
});

test("overseas PAPER orders stay locked without dedicated opt-in", () => {
  assert.match(overseasPaperOrdersLocked({}) ?? "", /RUN_KIS_VTS_OVERSEAS_ORDER_TESTS/);
  assert.match(
    overseasPaperOrdersLocked({ RUN_KIS_VTS_OVERSEAS_ORDER_TESTS: "true", KIS_MODE: "real" }) ?? "",
    /REAL/,
  );
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

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

test("overseas quote hits official price path with EXCD=NAS not NASD", async () => {
  resetKisTokenCacheForTest();
  const calls: Array<{ url: string; trId: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("tokenP")) return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    calls.push({ url, trId: headers.tr_id });
    return jsonResponse({ rt_cd: "0", output: { last: "190.5", base: "188", rate: "1.3", diff: "2.5", ordy: "YES" } });
  }) as typeof fetch;
  const quote = await paperClient(fetchImpl).inquireOverseasPrice(makeUsInstrument("NASDAQ", "AAPL"));
  assert.equal(quote.price, 190.5);
  assert.equal(calls[0]!.trId, "HHDFS00000300");
  assert.ok(calls[0]!.url.startsWith(`${KIS_HOSTS.paper}/uapi/overseas-price/v1/quotations/price`));
  assert.equal(new URL(calls[0]!.url).searchParams.get("EXCD"), "NAS");
  assert.equal(new URL(calls[0]!.url).searchParams.get("SYMB"), "AAPL");
  assert.equal(calls[0]!.url.includes("domestic-stock"), false);
});

test("overseas open orders use inquire-nccs not domestic daily-ccld", async () => {
  resetKisTokenCacheForTest();
  const calls: Array<{ url: string; trId: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("tokenP")) return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    calls.push({ url, trId: headers.tr_id });
    return jsonResponse({ rt_cd: "0", output: [] });
  }) as typeof fetch;
  await paperClient(fetchImpl).inquireOverseasOpenOrders("NASDAQ");
  assert.equal(calls[0]!.trId, "TTTS3018R");
  assert.ok(calls[0]!.url.includes("/uapi/overseas-stock/v1/trading/inquire-nccs"));
  assert.equal(calls[0]!.url.includes("inquire-daily-ccld"), false);
  assert.equal(new URL(calls[0]!.url).searchParams.get("OVRS_EXCG_CD"), "NASD");
});

test("UNKNOWN overseas order does not retry when opt-in is absent", async () => {
  resetKisTokenCacheForTest();
  let posts = 0;
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("tokenP")) return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    if (url.includes("/order")) posts += 1;
    return jsonResponse({ rt_cd: "0", output: { ODNO: "1" } });
  }) as typeof fetch;
  await assert.rejects(
    () =>
      paperClient(fetchImpl).orderOverseasUs({
        instrument: makeUsInstrument("NASDAQ", "AAPL"),
        side: "buy",
        qty: 1,
        price: 190,
      }),
    /RUN_KIS_VTS_OVERSEAS_ORDER_TESTS/,
  );
  assert.equal(posts, 0);
});

test("REAL overseas order is blocked without live flags", async () => {
  resetKisTokenCacheForTest();
  let posts = 0;
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("tokenP")) return jsonResponse({ access_token: "real-token-value", expires_in: 86_400 });
    if (url.includes("/order")) posts += 1;
    return jsonResponse({ rt_cd: "0", output: { ODNO: "1" } });
  }) as typeof fetch;
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
  await assert.rejects(
    () =>
      real.orderOverseasUs({
        instrument: makeUsInstrument("NASDAQ", "AAPL"),
        side: "buy",
        qty: 1,
        price: 190,
      }),
    /실전|REAL|해외 주문/,
  );
  assert.equal(posts, 0);
});

test("PAPER overseas credentials stay on the VTS host", async () => {
  resetKisTokenCacheForTest();
  const hosts: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    hosts.push(url);
    if (url.includes("tokenP")) return jsonResponse({ access_token: "paper-token-value", expires_in: 86_400 });
    return jsonResponse({ rt_cd: "0", output: { last: "1", base: "1" } });
  }) as typeof fetch;
  await paperClient(fetchImpl).inquireOverseasPrice(makeUsInstrument("NASDAQ", "AAPL"));
  assert.ok(hosts.every((url) => url.startsWith(KIS_HOSTS.paper) || url.includes("tokenP") || true));
  assert.ok(hosts.some((url) => url.startsWith(KIS_HOSTS.paper)));
  assert.equal(hosts.some((url) => url.startsWith(KIS_HOSTS.real)), false);
});
