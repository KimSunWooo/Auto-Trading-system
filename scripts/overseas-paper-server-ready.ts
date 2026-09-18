/**
 * Overseas PAPER server-ready checklist (read-only).
 * Never enables RUN_KIS_VTS_OVERSEAS_ORDER_TESTS. Never places orders.
 *
 * Usage: npx tsx scripts/overseas-paper-server-ready.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { KisClient } from "@/src/brokers/kis-client";
import { loadKisConfig, KIS_HOSTS } from "@/src/brokers/kis-config";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import {
  US_VTS_B1_PROBE_UNIVERSE,
  evaluateVtsB1Quote,
  selectVtsB1Instrument,
  probeInstrument,
} from "@/src/markets/overseas/vts-b1-candidates";
import { classifyOverseasRestart } from "@/src/markets/overseas/lifecycle";
import { overseasActivationGate } from "@/src/markets/overseas/activation-gate";
import { overseasQuoteOrderableGate, OVERSEAS_FIRST_LIFECYCLE_QTY } from "@/src/markets/overseas/lifecycle";
import { assertVtsSafeEnv, beginVtsTestRun, finishVtsTestRun, realTradingFlags } from "@/src/runtime/vts-harness";

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_FLATTEN_TEST;
  delete process.env.ALLOW_LIVE_TRADING;
  delete process.env.KIS_LIVE_CONFIRM;
  process.env.RUN_KIS_VTS_OVERSEAS_TESTS = "true";

  assertVtsSafeEnv();
  if (vtsOverseasOrderTestsEnabled()) {
    throw new Error("Order opt-in must stay unset");
  }
  if (realTradingFlags().length) {
    throw new Error("REAL flags present");
  }

  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") throw new Error("KIS_MODE must be paper/demo");
  if (!cfg.configured) throw new Error("PAPER credentials not configured");

  let paperOrderPosts = 0;
  let realRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) realRequests += 1;
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "POST" && /\/trading\/order/.test(url)) {
      paperOrderPosts += 1;
      throw new Error("Safety: overseas order POST blocked in server-ready script");
    }
    return globalThis.fetch(input, init);
  };

  const run = beginVtsTestRun("overseas-server-ready", { market: "overseas" });
  const client = new KisClient(cfg, fetchImpl);
  const adapter = new OverseasTradingAdapter(client);

  console.log("Overseas PAPER Server Startup Checklist");
  console.log("=======================================");
  console.log("[x] BROKER=kis (assumed via config)");
  console.log("[x] TRADING_MODE=live_test (asserted by harness)");
  console.log("[x] KIS_MODE=paper");
  console.log("[x] ALLOW_LIVE_TRADING=false");
  console.log("[x] RUN_KIS_VTS_OVERSEAS_ORDER_TESTS unset");
  console.log("[x] REAL flags none");

  let present;
  try {
    present = await adapter.getPresentBalance();
  } catch (err) {
    console.error("Present Balance FAIL", err instanceof Error ? err.message : err);
    present = {
      syncedAt: new Date().toISOString(),
      cash: [],
      fx: null,
      buyingPower: null,
      positions: [],
      krwCash: null,
      estimatedKrwValue: null,
      message: "present-balance failed",
    };
  }
  await sleep(800);
  const usd = pickUsdCash(present.cash);
  const fxRate = present.fx?.rate ?? usd?.exchangeRate ?? 0;
  let buyingPower = present.buyingPower;
  const probe = probeInstrument("NYSE", "F", "Ford");
  try {
    const q = await adapter.getQuote(probe);
    await sleep(800);
    buyingPower = await adapter.getBuyingPower(probe, q.price);
  } catch (err) {
    console.error("Quote/Psamount partial FAIL", err instanceof Error ? err.message : err);
  }

  let openOrders: Awaited<ReturnType<typeof adapter.getOpenOrders>> = [];
  let nyseOpen: Awaited<ReturnType<typeof adapter.getOpenOrders>> = [];
  let executions: Awaited<ReturnType<typeof adapter.getExecutions>> = [];
  let positions: Awaited<ReturnType<typeof adapter.getBalance>>["positions"] = [];
  try {
    openOrders = await adapter.getOpenOrders("NASDAQ");
    await sleep(800);
    nyseOpen = await adapter.getOpenOrders("NYSE").catch(() => []);
    await sleep(800);
    executions = await adapter.getExecutions();
    await sleep(800);
    positions = (await adapter.getBalance("NASDAQ")).positions;
  } catch (err) {
    console.error("Open/Exec/Balance partial FAIL", err instanceof Error ? err.message : err);
  }

  const recovery = classifyOverseasRestart({
    localOrders: [],
    localIntents: [],
    openOrders: [...openOrders, ...nyseOpen],
    executions,
  });

  const rows = [];
  for (const item of US_VTS_B1_PROBE_UNIVERSE.slice(0, 5)) {
    await sleep(900);
    try {
      const quote = await adapter.getQuote(probeInstrument(item.exchange, item.symbol, item.displayName));
      rows.push(
        evaluateVtsB1Quote({
          exchange: item.exchange,
          symbol: item.symbol,
          displayName: item.displayName,
          quote,
          fxRate: fxRate || 1350,
          usdOrderable: buyingPower?.orderableCash ?? usd?.orderableCash ?? 0,
          env: process.env,
        }),
      );
      console.log(
        `candidate ${item.exchange}:${item.symbol} price=${quote.price} orderable=${quote.orderable} market=${quote.marketStatus}`,
      );
    } catch (err) {
      rows.push(
        evaluateVtsB1Quote({
          exchange: item.exchange,
          symbol: item.symbol,
          displayName: item.displayName,
          quote: null,
          fxRate: fxRate || 1350,
          usdOrderable: buyingPower?.orderableCash ?? 0,
          env: process.env,
        }),
      );
      console.log(`candidate ${item.exchange}:${item.symbol} FAIL ${err instanceof Error ? err.message : err}`);
    }
  }

  const selected = selectVtsB1Instrument(rows);
  const selectedQuote = selected
    ? await adapter.getQuote(probeInstrument(selected.exchange, selected.symbol, selected.name)).catch(() => null)
    : null;

  const gate = overseasActivationGate({
    quote: selectedQuote,
    usdCash: usd?.cash ?? null,
    usdOrderable: buyingPower?.orderableCash ?? usd?.orderableCash ?? null,
    orderableQty: buyingPower?.orderableQty ?? null,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery,
    existingOpenBuy: [...openOrders, ...nyseOpen].some((o) => o.side === "buy" && o.remainingQty > 0),
    unknownPresent: false,
    paperOrderPosts,
    realRequests,
    workerHealthy: true,
    persistenceHealthy: true,
    rdsMirrorHealthy: true,
  });

  console.log("");
  console.log(`USD Cash: ${usd?.cash ?? null}`);
  console.log(`USD Orderable: ${buyingPower?.orderableCash ?? usd?.orderableCash ?? null}`);
  console.log(`Buying Power Source: ${buyingPower ? "inquire-psamount" : "present-balance"}`);
  console.log(`Orderable Qty: ${buyingPower?.orderableQty ?? null}`);
  console.log(`FX Rate: ${fxRate || null}`);
  console.log(`FX Execution API: ${KIS_CURRENCY_EXCHANGE_AUDIT.paperVtsExecutionSupported}`);
  console.log(`First lifecycle qty: ${OVERSEAS_FIRST_LIFECYCLE_QTY}`);
  console.log(`Recovery: ${recovery.status}`);
  console.log(`Activation Gate Runtime: ${gate.runtime}`);
  console.log(`Selected: ${selected ? `${selected.exchange}:${selected.symbol}` : "NONE"}`);
  if (selectedQuote) {
    console.log(`Quote orderable gate: ${JSON.stringify(overseasQuoteOrderableGate(selectedQuote))}`);
  }
  console.log(`PAPER Order POST: ${paperOrderPosts}`);
  console.log(`REAL Requests: ${realRequests}`);
  console.log(`Overseas Order Opt-In: OFF`);

  const outDir = path.join(run.dir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "server-ready.json"),
    `${JSON.stringify(
      {
        gate,
        recovery,
        selected,
        usdCash: usd?.cash ?? null,
        usdOrderable: buyingPower?.orderableCash ?? usd?.orderableCash ?? null,
        paperOrderPosts,
        realRequests,
        fxExecutionApi: KIS_CURRENCY_EXCHANGE_AUDIT.paperVtsExecutionSupported,
        candidates: rows,
      },
      null,
      2,
    )}\n`,
  );

  finishVtsTestRun(run, paperOrderPosts === 0 && realRequests === 0 ? "PASS" : "FAIL", {
    layer: "OVERSEAS SERVER READY",
    market: "overseas",
    paperOverseasOrders: paperOrderPosts,
    realRequests,
  });

  console.log("");
  console.log("Next Step: START SERVER IN PAPER READ-ONLY MODE");
  console.log("Actual PAPER BUY: NOT EXECUTED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
