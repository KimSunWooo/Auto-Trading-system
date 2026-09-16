/**
 * Overseas VTS-B preflight / funding audit.
 * Read-only. Does not set order opt-in. Does not place PAPER or REAL orders.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KisClient } from "@/src/brokers/kis-client";
import { KIS_HOSTS, loadKisConfig } from "@/src/brokers/kis-config";
import { KIS_CURRENCY_EXCHANGE_AUDIT, KIS_PAPER_OVERSEAS_FUNDING_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { mapForeignCashRows, mapPsamount, sanitizeKisRecord } from "@/src/markets/overseas/mapping";
import { overseasVtsBPreflight } from "@/src/markets/overseas/preflight";
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

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === "object") return Object.keys(first as object);
    return [];
  }
  if (value && typeof value === "object") return Object.keys(value as object);
  return [];
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
    throw new Error("VTS-B preflight aborted: RUN_KIS_VTS_OVERSEAS_ORDER_TESTS must stay unset");
  }
  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") {
    throw new Error("VTS-B preflight aborted: KIS_MODE is not paper/demo");
  }
  if (!cfg.configured) {
    throw new Error("VTS-B preflight aborted: PAPER credentials are not configured");
  }

  let paperOrderPosts = 0;
  let realRequests = 0;
  const captured: Array<{ url: string; trId: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) realRequests += 1;
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "POST" && /\/trading\/order/.test(url)) {
      paperOrderPosts += 1;
      throw new Error("Overseas VTS-B preflight safety: order POST blocked");
    }
    const res = await globalThis.fetch(input, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { nonJson: true };
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!url.includes("tokenP")) {
      captured.push({
        url: url.split("?")[0] ?? url,
        trId: headers.tr_id ?? headers.tr_id,
        body: sanitizeKisRecord(parsed),
      });
    }
    return new Response(text, { status: res.status, headers: res.headers });
  };

  const client = new KisClient(cfg, fetchImpl);
  const run = beginVtsTestRun("OVTS-B-PREFLIGHT", { market: "overseas" });
  const instrument = makeUsInstrument("NASDAQ", "AAPL");

  await sleep(1200);
  const quote = await client.inquireOverseasPrice(instrument);
  await sleep(1200);
  const present = await client.inquireOverseasPresentBalance();
  await sleep(1200);
  const buyingPower = await client.inquireOverseasPsamount(instrument, quote.price);
  await sleep(1200);
  const { positions, summary } = await client.inquireOverseasBalance("NASDAQ");
  await sleep(1200);
  const open = await client.inquireOverseasOpenOrders("NASDAQ");
  await sleep(1200);
  const execs = await client.inquireOverseasExecutions();

  const usd = pickUsdCash(present.cash);
  const presentCapture = captured.find((row) => row.url.includes("inquire-present-balance"));
  const psamountCapture = captured.find((row) => row.url.includes("inquire-psamount"));
  const balanceCapture = captured.find((row) => row.url.includes("inquire-balance"));
  const presentJson = (presentCapture?.body ?? {}) as Record<string, unknown>;
  const mappedFromRaw = mapForeignCashRows(presentJson.output2 ?? presentJson.output, null);
  const psamountJson = (psamountCapture?.body ?? {}) as Record<string, unknown>;
  const psamountRaw = (psamountJson.output ?? psamountJson.output1 ?? {}) as Record<string, unknown>;
  const psamountMapped = mapPsamount(psamountRaw, instrument);

  const rawUsdRow = Array.isArray(presentJson.output2)
    ? (presentJson.output2 as Array<Record<string, unknown>>).find((row) => String(row.crcy_cd ?? "").toUpperCase() === "USD")
    : presentJson.output2 && typeof presentJson.output2 === "object"
      ? (presentJson.output2 as Record<string, unknown>)
      : undefined;

  const officialCashFieldPresent = rawUsdRow
    ? "frcr_dncl_amt_2" in rawUsdRow || "FRCR_DNCL_AMT_2" in rawUsdRow
    : false;
  const officialCashValue = rawUsdRow
    ? Number(String(rawUsdRow.frcr_dncl_amt_2 ?? rawUsdRow.FRCR_DNCL_AMT_2 ?? "").replace(/,/g, ""))
    : null;
  const officialUseValue = rawUsdRow
    ? Number(String(rawUsdRow.frcr_use_psbl_amt ?? rawUsdRow.FRCR_USE_PSBL_AMT ?? "").replace(/,/g, ""))
    : null;

  let zeroCause: "ACCOUNT STATE" | "MAPPING BUG" | "UNKNOWN" = "UNKNOWN";
  if (rawUsdRow && officialCashFieldPresent && (officialCashValue === 0 || Number.isNaN(officialCashValue))) {
    zeroCause = "ACCOUNT STATE";
  } else if (rawUsdRow && officialCashFieldPresent && officialCashValue && officialCashValue > 0 && (usd?.cash ?? 0) === 0) {
    zeroCause = "MAPPING BUG";
  } else if (rawUsdRow && !officialCashFieldPresent) {
    zeroCause = "UNKNOWN";
  } else if ((usd?.cash ?? 0) === 0 && (usd?.orderableCash ?? 0) === 0) {
    zeroCause = officialCashFieldPresent ? "ACCOUNT STATE" : "UNKNOWN";
  }

  const preflight = overseasVtsBPreflight({
    quoteHealthy: quote.price > 0 && quote.source === "kis",
    foreignBalanceHealthy: Boolean(usd),
    reconciliationHealthy: true,
    marketStatus: quote.marketStatus,
    riskHealthy: true,
    usdCash: usd?.cash ?? 0,
    usdOrderable: buyingPower.orderableCash || usd?.orderableCash || 0,
    nativePrice: quote.price,
    fxRate: present.fx?.rate ?? usd?.exchangeRate ?? null,
    symbol: "AAPL",
  });

  const report = {
    market: "overseas",
    layer: "OVERSEAS VTS-B PREFLIGHT",
    optIn: {
      RUN_KIS_VTS_OVERSEAS_ORDER_TESTS: process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS ?? null,
      RUN_KIS_VTS_ORDER_TESTS: process.env.RUN_KIS_VTS_ORDER_TESTS ?? null,
      RUN_KIS_VTS_FLATTEN_TEST: process.env.RUN_KIS_VTS_FLATTEN_TEST ?? null,
      ALLOW_LIVE_TRADING: process.env.ALLOW_LIVE_TRADING ?? null,
      KIS_LIVE_CONFIRM: process.env.KIS_LIVE_CONFIRM ?? null,
    },
    realFlags: realTradingFlags(),
    quote: {
      identity: quote.identity,
      price: quote.price,
      currency: quote.currency,
      marketStatus: quote.marketStatus,
      orderable: quote.orderable,
    },
    mapping: {
      presentBalanceTr: "VTRP6504R",
      balanceTr: "VTTS3012R",
      psamountTr: "VTTS3007R",
      presentOutput2Keys: keysOf(presentJson.output2),
      presentOutput3Keys: keysOf(presentJson.output3),
      psamountOutputKeys: keysOf(psamountJson.output ?? psamountJson.output1),
      balanceOutput2Keys: keysOf((balanceCapture?.body as Record<string, unknown> | undefined)?.output2),
      rawUsdRow: rawUsdRow ? sanitizeKisRecord(rawUsdRow) : null,
      officialCashFieldPresent,
      officialCashValue: Number.isFinite(officialCashValue) ? officialCashValue : null,
      officialUseValue: Number.isFinite(officialUseValue) ? officialUseValue : null,
      mappedPresentUsd: mappedFromRaw.cash.find((row) => row.currency === "USD") ?? null,
      mappedPsamount: psamountMapped,
      clientUsd: usd ?? null,
      fx: present.fx,
      krwCash: present.krwCash,
    },
    positions: positions.length,
    openOrders: open.length,
    executions: execs.length,
    balanceSummaryKeys: keysOf(summary),
    fundingAudit: KIS_PAPER_OVERSEAS_FUNDING_AUDIT,
    exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
    preflight,
    paperOverseasOrders: paperOrderPosts,
    realRequests,
    zeroCause,
  };

  writeFileSync(path.join(run.dir, "overseas-vts-b-preflight.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  appendVtsEvent(run.dir, { kind: "preflight", blocked: preflight.blocked, usd: usd?.cash ?? 0, orderable: usd?.orderableCash ?? 0 });
  finishVtsTestRun(run, paperOrderPosts > 0 || realRequests > 0 ? "FAIL" : "BLOCKED", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
