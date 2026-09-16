/**
 * Overseas VTS-B1 candidate scan + final preflight.
 * Read-only. Does not raise LIVE_TEST caps. Does not place PAPER or REAL orders.
 * RUN_KIS_VTS_OVERSEAS_ORDER_TESTS stays unset.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KisClient } from "@/src/brokers/kis-client";
import { KIS_HOSTS, loadKisConfig } from "@/src/brokers/kis-config";
import { vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { sanitizeKisRecord } from "@/src/markets/overseas/mapping";
import { overseasMaxUsdPricePerShare, overseasVtsBPreflight } from "@/src/markets/overseas/preflight";
import {
  US_VTS_B1_PROBE_UNIVERSE,
  evaluateVtsB1Quote,
  selectVtsB1Instrument,
} from "@/src/markets/overseas/vts-b1-candidates";
import { DEFAULT_LIVE_TEST_CAPS } from "@/src/runtime/trading-mode";
import {
  appendVtsEvent,
  assertVtsSafeEnv,
  beginVtsTestRun,
  finishVtsTestRun,
  realTradingFlags,
} from "@/src/runtime/vts-harness";

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadDotEnvLocal();
  process.env.RUN_KIS_VTS_OVERSEAS_TESTS = "true";
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_FLATTEN_TEST;
  delete process.env.VTS_TEST_SYMBOL;
  delete process.env.VTS_OVERSEAS_TEST_SYMBOL;
  delete process.env.ALLOW_LIVE_TRADING;
  delete process.env.KIS_LIVE_CONFIRM;

  assertVtsSafeEnv();
  if (vtsOverseasOrderTestsEnabled()) {
    throw new Error("VTS-B1 aborted: RUN_KIS_VTS_OVERSEAS_ORDER_TESTS must stay unset");
  }
  if (DEFAULT_LIVE_TEST_CAPS.maxOrderKrw !== 10_000) {
    throw new Error("VTS-B1 aborted: LIVE_TEST maxOrderKrw changed");
  }
  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") {
    throw new Error("VTS-B1 aborted: KIS_MODE is not paper/demo");
  }
  if (!cfg.configured) {
    throw new Error("VTS-B1 aborted: PAPER credentials are not configured");
  }

  let overseasBuy = 0;
  let overseasSell = 0;
  let cancelCalls = 0;
  let realRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) realRequests += 1;
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "POST" && /\/trading\/order-rvsecncl/.test(url)) {
      cancelCalls += 1;
      throw new Error("VTS-B1 safety: cancel POST blocked");
    }
    if (method === "POST" && /\/trading\/order/.test(url)) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const tr = String(headers.tr_id ?? "");
      if (/1001U$|SELL/i.test(tr)) overseasSell += 1;
      else overseasBuy += 1;
      throw new Error("VTS-B1 safety: order POST blocked");
    }
    return globalThis.fetch(input, init);
  };

  const client = new KisClient(cfg, fetchImpl);
  const run = beginVtsTestRun("OVTS-B1", { market: "overseas" });

  await sleep(1200);
  const present = await client.inquireOverseasPresentBalance();
  const usdCash = pickUsdCash(present.cash);
  const fxRate = present.fx?.rate ?? usdCash?.exchangeRate ?? null;
  if (fxRate == null || fxRate <= 0) {
    throw new Error("VTS-B1 aborted: KIS FX rate missing");
  }
  const maxUsd = overseasMaxUsdPricePerShare(fxRate, DEFAULT_LIVE_TEST_CAPS.maxOrderKrw);
  const aapl = makeUsInstrument("NASDAQ", "AAPL");
  await sleep(1200);
  const aaplQuote = await client.inquireOverseasPrice(aapl);
  await sleep(1200);
  const buyingPower = await client.inquireOverseasPsamount(aapl, aaplQuote.price);
  const usdOrderable = buyingPower.orderableCash;

  const candidates = [];
  for (const probe of US_VTS_B1_PROBE_UNIVERSE) {
    await sleep(1200);
    const instrument = makeUsInstrument(probe.exchange, probe.symbol, probe.displayName);
    try {
      const quote = await client.inquireOverseasPrice(instrument);
      candidates.push(
        evaluateVtsB1Quote({
          exchange: instrument.exchange,
          symbol: instrument.symbol,
          displayName: quote.displayName || probe.displayName,
          quote,
          fxRate,
          usdOrderable,
        }),
      );
    } catch (err) {
      candidates.push(
        evaluateVtsB1Quote({
          exchange: probe.exchange,
          symbol: probe.symbol,
          displayName: probe.displayName,
          quote: null,
          fxRate,
          usdOrderable,
        }),
      );
      appendVtsEvent(run.dir, {
        kind: "quote_miss",
        symbol: probe.symbol,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const selected = selectVtsB1Instrument(candidates);
  let selectedName = selected?.name;
  if (selected) {
    await sleep(1200);
    const found = await client.searchOverseasInstrument(selected.symbol, selected.exchange);
    if (found?.displayName) selectedName = found.displayName;
  }
  let selectedPsamount = buyingPower;
  if (selected?.priceUsd) {
    await sleep(1200);
    selectedPsamount = await client.inquireOverseasPsamount(
      makeUsInstrument(selected.exchange, selected.symbol, selected.name),
      selected.priceUsd,
    );
  }

  await sleep(1200);
  const { positions } = await client.inquireOverseasBalance("NASDAQ");
  await sleep(1200);
  const open = await client.inquireOverseasOpenOrders("NASDAQ");
  await sleep(1200);
  const execs = await client.inquireOverseasExecutions();

  const preflight = overseasVtsBPreflight({
    quoteHealthy: Boolean(selected?.quoteAvailable && (selected.priceUsd ?? 0) > 0),
    foreignBalanceHealthy: usdOrderable > 0 || usdCash != null,
    reconciliationHealthy: true,
    marketStatus: selected?.marketStatus === "open" ? "open" : "closed",
    riskHealthy: true,
    usdCash: usdCash?.cash ?? 0,
    usdOrderable: selectedPsamount.orderableCash,
    nativePrice: selected?.priceUsd ?? null,
    fxRate,
    symbol: selected?.symbol,
  });

  const marketOpen = selected?.marketStatus === "open";
  const report = {
    market: "overseas",
    layer: "OVERSEAS VTS-B1",
    caps: { maxOrderKrw: DEFAULT_LIVE_TEST_CAPS.maxOrderKrw },
    fxRate,
    maxUsdPricePerShare: maxUsd,
    usdCash: usdCash?.cash ?? 0,
    usdOrderable,
    selectedOrderable: selectedPsamount.orderableCash,
    psamountRawHint: sanitizeKisRecord({
      currency: selectedPsamount.currency,
      orderableCash: selectedPsamount.orderableCash,
      orderableQty: selectedPsamount.orderableQty,
      symbol: selectedPsamount.symbol,
    }),
    optIn: {
      RUN_KIS_VTS_OVERSEAS_ORDER_TESTS: process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS ?? null,
      RUN_KIS_VTS_ORDER_TESTS: process.env.RUN_KIS_VTS_ORDER_TESTS ?? null,
    },
    realFlags: realTradingFlags(),
    candidates,
    selected: selected ? { ...selected, name: selectedName ?? selected.name } : null,
    positions: positions.length,
    openOrders: open.length,
    executions: execs.length,
    preflight,
    marketOpen,
    expected:
      selected && selected.priceUsd != null
        ? {
            symbol: selected.symbol,
            exchange: selected.exchange,
            qty: 1,
            priceUsd: selected.priceUsd,
            fxRate,
            usdNotional: selected.priceUsd,
            krwNotional: selected.krwNotional,
            liveTestLimitKrw: DEFAULT_LIVE_TEST_CAPS.maxOrderKrw,
            riskEligible: selected.riskEligible,
            fundingEligible: selected.priceUsd <= selectedPsamount.orderableCash,
            marketOpen,
          }
        : null,
    http: {
      overseasBuy,
      overseasSell,
      cancelCalls,
      realRequests,
    },
    blocked:
      !selected
        ? "ORDER TEST BLOCKED: no LIVE_TEST-eligible US instrument"
        : !marketOpen
          ? "ORDER TEST BLOCKED: US market closed"
          : preflight.blocked,
  };

  writeFileSync(path.join(run.dir, "overseas-vts-b1.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  appendVtsEvent(run.dir, { kind: "b1", selected: selected?.symbol ?? null, marketOpen, blocked: report.blocked });
  const outcome = overseasBuy + overseasSell + cancelCalls + realRequests > 0 ? "FAIL" : "BLOCKED";
  finishVtsTestRun(run, outcome, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
