/**
 * PAPER Long Soak Runtime Health — read-only observation for an already-armed rule.
 * Never enable/disable rules. Never toggles autoTrading. Never places orders.
 *
 * Distinct from activation gate (PRE-ACTIVATION ONLY).
 * Quote freshness: Health Observation <=120s vs Order Eligible <=15s.
 *
 * Usage: npx tsx scripts/paper-long-soak-runtime-health.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { brokerDriver } from "@/src/brokers/kis-config";
import { tradingMode } from "@/src/runtime/trading-mode";
import {
  LONG_SOAK_TICKER,
  evaluateRuntimeHealth,
  formatRuntimeHealthReport,
} from "@/src/runtime/paper-long-soak-health";

const BASE = process.env.LONG_SOAK_BASE_URL ?? "http://127.0.0.1:43147";

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

async function loadLiveState(): Promise<AppState & { runtime?: { worker?: string } }> {
  try {
    const res = await fetch(`${BASE}/api/state`);
    if (res.ok) return (await res.json()) as AppState & { runtime?: { worker?: string } };
  } catch {
    // fall through to file snapshot
  }
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "paper-account.json"), "utf8"),
  ) as AppState;
}

async function main() {
  loadDotEnvLocal();
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("Refuse REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") {
    throw new Error("Refuse REAL mode");
  }
  delete process.env.KIS_LIVE_CONFIRM;

  const state = await loadLiveState();
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker: state.runtime?.worker,
    includeLockProbe: true,
  });
  const histLen = state.quotes[LONG_SOAK_TICKER]?.history?.length ?? 0;

  console.log(
    formatRuntimeHealthReport(report, {
      broker: brokerDriver(),
      tradingMode: tradingMode(),
      kisMode: String(process.env.KIS_MODE ?? "paper"),
      autoTrading: state.settings?.autoTrading,
      historyLen: histLen,
    }),
  );
  console.log("");
  console.log("NOTE: Runtime health is observational. Order path still enforces");
  console.log("OrderManager / preTradeGate / worker lock / KIS freshAt<=15s / recon / UNKNOWN.");
  console.log("Broker order HTTP POST: 0 (health does not submit)");

  if (!report.runtimeHealthReady) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
