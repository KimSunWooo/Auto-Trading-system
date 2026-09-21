/**
 * Overseas PAPER runtime health — read-only observation against live server state.
 * Never enables order opt-in. Never places BUY/SELL/CANCEL.
 *
 * Distinct from server-ready preparation checklist.
 * Usage: npx tsx scripts/overseas-paper-runtime-health.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { KisClient } from "@/src/brokers/kis-client";
import { loadKisConfig, KIS_HOSTS, brokerDriver } from "@/src/brokers/kis-config";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import {
  classifyOverseasRestart,
  overseasStateFromApp,
  OVERSEAS_FIRST_LIFECYCLE_QTY,
} from "@/src/markets/overseas/lifecycle";
import { overseasActivationGate } from "@/src/markets/overseas/activation-gate";
import {
  exchangeCoverageAttemptedOk,
  positionCoverageByExchange,
} from "@/src/markets/overseas/exchange-coverage";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { holdsWorkerLock, workerLockHealthy, defaultLockPath } from "@/src/runtime/worker-lock";
import { workerRuntimeHealthy, workerRuntimeStatus } from "@/src/runtime/paper-long-soak-health";
import { tradingMode } from "@/src/runtime/trading-mode";
import { realTradingFlags } from "@/src/runtime/vts-harness";

const BASE = process.env.OVERSEAS_BASE_URL ?? "http://127.0.0.1:43147";

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

async function loadAppState(): Promise<AppState & { runtime?: { worker?: string } }> {
  try {
    const res = await fetch(`${BASE}/api/state`);
    if (res.ok) return (await res.json()) as AppState & { runtime?: { worker?: string } };
  } catch {
    // fall through
  }
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "paper-account.json"), "utf8"),
  ) as AppState;
}

async function main() {
  loadDotEnvLocal();
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("ABORT REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") throw new Error("ABORT REAL");
  if (process.env.KIS_LIVE_CONFIRM) throw new Error("ABORT LIVE CONFIRM");
  if (vtsOverseasOrderTestsEnabled()) throw new Error("Order opt-in must stay OFF");
  if (realTradingFlags().length) throw new Error("REAL flags present");

  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") throw new Error("KIS_MODE must be paper");

  let paperOrderPosts = 0;
  let realRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) realRequests += 1;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && /\/trading\/order/.test(url)) {
      paperOrderPosts += 1;
      throw new Error("Safety: overseas order POST blocked in runtime-health");
    }
    return globalThis.fetch(input, init);
  };

  const state = await loadAppState();
  const local = overseasStateFromApp(state);
  const runtimeWorker = state.runtime?.worker ?? null;
  const workerLockOk = holdsWorkerLock() || workerLockHealthy({ filePath: defaultLockPath() });
  const db = publicDatabaseStatus();
  const adapter = new OverseasTradingAdapter(new KisClient(cfg, fetchImpl));

  const present = await adapter.getPresentBalance().catch(() => null);
  const usd = present ? pickUsdCash(present.cash) : null;
  const { orders: openOrders, probes: openProbes } = await adapter.getAllOpenOrders();
  const executions = await adapter.getExecutions().catch(() => []);
  const { positions, probes: positionProbes } = await adapter.getAllPositions();
  const coverage = positionCoverageByExchange(positions);
  const recovery = classifyOverseasRestart({
    localIntents: local.intents,
    localOrders: local.orders,
    openOrders,
    executions,
  });

  let buyingPower = present?.buyingPower ?? null;
  let quote = null;
  // Probe AAPL only for market status — not a fixed lifecycle pick.
  try {
    const { makeUsInstrument } = await import("@/src/markets/overseas/instruments");
    const probe = makeUsInstrument("NASDAQ", "AAPL");
    quote = await adapter.getQuote(probe);
    buyingPower = await adapter.resolveFreshBuyingPower(probe, quote.price);
  } catch {
    // leave null
  }

  const gate = overseasActivationGate({
    quote,
    usdCash: usd?.cash ?? null,
    usdOrderable: buyingPower?.orderableCash ?? usd?.orderableCash ?? null,
    orderableQty: buyingPower?.orderableQty ?? null,
    presentBalanceOk: present != null,
    positionsOk: exchangeCoverageAttemptedOk(positionProbes),
    openOrdersOk: exchangeCoverageAttemptedOk(openProbes),
    executionsOk: true,
    recovery,
    existingOpenBuy: openOrders.some((o) => o.side === "buy" && o.remainingQty > 0),
    unknownPresent:
      local.orders.some((o) => o.status === "unknown") || recovery.status === "UNKNOWN_BLOCKING",
    paperOrderPosts,
    realRequests,
    runtimeWorker,
    workerLockOk,
    persistenceHealthy: true,
  });

  console.log("Overseas PAPER Runtime Health");
  console.log("=============================");
  console.log(`BROKER: ${brokerDriver()}`);
  console.log(`TRADING_MODE: ${tradingMode()}`);
  console.log(`KIS_MODE: paper`);
  console.log(`REAL: LOCKED`);
  console.log(`Overseas Order Opt-In: OFF`);
  console.log("");
  console.log(`Worker Runtime: ${workerRuntimeStatus(runtimeWorker)} (${workerRuntimeHealthy(runtimeWorker) ? "PASS" : "FAIL"})`);
  console.log(`Worker Lock: ${workerLockOk ? "HEALTHY" : "FAIL"}`);
  console.log(`RDS: mode=${db.mode} connected=${db.connected} enabled=${db.enabled}`);
  console.log(`Recovery: ${recovery.status}`);
  console.log(`UNKNOWN: ${gate.checks.unknown}`);
  console.log(`REMOTE_ONLY: ${recovery.status === "REMOTE_ONLY" ? "PRESENT" : "NONE"}`);
  console.log(`Open BUY: ${openOrders.some((o) => o.side === "buy" && o.remainingQty > 0) ? "PRESENT" : "NONE"}`);
  console.log(`Positions: ${positions.length} (NASDAQ=${coverage.NASDAQ} NYSE=${coverage.NYSE} AMEX=${coverage.AMEX})`);
  console.log(`USD Cash: ${usd?.cash ?? null}`);
  console.log(`USD Orderable: ${buyingPower?.orderableCash ?? usd?.orderableCash ?? null}`);
  console.log(`First Lifecycle Qty: ${OVERSEAS_FIRST_LIFECYCLE_QTY}`);
  console.log(`Gate Runtime: ${gate.runtime}`);
  console.log(`PAPER BUY/SELL/CANCEL POST: ${paperOrderPosts}`);
  console.log(`REAL Requests: ${realRequests}`);
  console.log("");
  console.log("NOTE: Health READY ≠ order enabled. Opt-in stays OFF.");

  if (paperOrderPosts !== 0 || realRequests !== 0 || gate.runtime === "BLOCKED") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
