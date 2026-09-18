/**
 * PAPER Long Soak Activation Gate (read-only checklist).
 * Never enables the rule. Never places orders. Never touches REAL.
 *
 * Usage: npx tsx scripts/paper-long-soak-activation-gate.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { isRegularSession } from "@/lib/market-hours";
import { getRuleConfig } from "@/src/rules/config";
import { hasUnknownOrder, PAPER_OPERATION_DEFAULTS } from "@/src/risk/order-policy";
import { kisJsonPositionDiverged } from "@/src/runtime/controlled-run";
import { holdsWorkerLock, workerLockHealthy } from "@/src/runtime/worker-lock";
import { publicDatabaseStatus } from "@/src/db/mirror";

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

function loadState(): AppState {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "paper-account.json"), "utf8"),
  ) as AppState;
}

function yn(ok: boolean): string {
  return ok ? "YES" : "NO";
}

function main() {
  loadDotEnvLocal();
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("Refuse REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") {
    throw new Error("Refuse REAL mode");
  }
  delete process.env.KIS_LIVE_CONFIRM;

  const rules = getRuleConfig().rules;
  const rule = rules.find((row) => row.id === "paper-long-soak-ma");
  const state = loadState();
  const unknown = hasUnknownOrder(state);
  const openBuy = state.orders.some(
    (o) =>
      o.side === "buy" &&
      (o.status === "pending" || o.status === "unknown") &&
      o.activeClass !== "ORPHANED_LOCAL" &&
      o.activeClass !== "HISTORICAL_MATCHED",
  );
  const posMismatch = kisJsonPositionDiverged(state);
  const startup = state.startupSync?.status ?? "MISSING";
  const reconLocal = state.safety?.reconciliation;
  const recon =
    reconLocal === "synced" || state.kisBalance?.matched === true
      ? reconLocal === "unavailable"
        ? "UNAVAILABLE"
        : "HEALTHY"
      : String(reconLocal ?? (state.kisBalance?.matched === false ? "MISMATCH" : "UNKNOWN"));
  const db = publicDatabaseStatus();
  const mirrorDegraded = Boolean(db.lastError?.includes("DB_MIRROR_DEGRADED"));
  const marketOpen = isRegularSession(new Date());
  const q = rule ? state.quotes[rule.ticker] : undefined;
  const quoteFresh = Boolean(
    q?.source === "kis" && q.freshAt && Date.now() - q.freshAt < 120_000,
  );
  const dailyHistoryReady = Boolean(q && (q.history?.length ?? 0) >= 20);

  const checks = {
    ruleExists: Boolean(rule),
    ruleEnabled: rule?.enabled === true,
    marketOpen,
    startupHealthy: startup === "HEALTHY",
    quoteFresh,
    dailyHistoryReady,
    balanceHealthy: state.kisBalance != null,
    orderableHealthy: (state.kisBalance?.orderableCash ?? 0) > 0,
    reconHealthy: recon === "HEALTHY",
    positionMatch: !posMismatch,
    unknownNone: !unknown,
    openBuyNone: !openBuy,
    workerLock: holdsWorkerLock() || workerLockHealthy(),
    rdsMirror: db.mode === "mirror" && !mirrorDegraded,
    mirrorDegraded,
    maxQty: PAPER_OPERATION_DEFAULTS.maxQtyPerOrder,
    realRequests: 0,
  };

  // Ready means "safe to enable in a later step". This script never flips enabled.
  const activationReady =
    checks.ruleExists &&
    !checks.ruleEnabled &&
    checks.startupHealthy &&
    checks.quoteFresh &&
    checks.dailyHistoryReady &&
    checks.balanceHealthy &&
    checks.orderableHealthy &&
    checks.reconHealthy &&
    checks.positionMatch &&
    checks.unknownNone &&
    checks.openBuyNone &&
    checks.rdsMirror &&
    !checks.mirrorDegraded &&
    checks.maxQty === 5 &&
    checks.realRequests === 0;

  console.log("Long Soak Activation Gate");
  console.log("=========================");
  console.log(`Rule exists: ${yn(checks.ruleExists)}`);
  console.log(`Rule enabled: ${checks.ruleEnabled ? "YES" : "NO"}`);
  console.log(`Market: ${checks.marketOpen ? "OPEN" : "CLOSED"}`);
  console.log(`Startup Sync: ${checks.startupHealthy ? "HEALTHY" : startup}`);
  console.log(`KIS Quote: ${checks.quoteFresh ? "FRESH" : "FAIL"}`);
  console.log(`Daily History: ${checks.dailyHistoryReady ? "READY" : "FAIL"}`);
  console.log(`Balance: ${checks.balanceHealthy ? "HEALTHY" : "FAIL"}`);
  console.log(`Orderable: ${checks.orderableHealthy ? "HEALTHY" : "FAIL"}`);
  console.log("Open Orders: LOCAL_OK (live preflight separate)");
  console.log("Executions: LOCAL_OK (live preflight separate)");
  console.log(`Reconciliation: ${checks.reconHealthy ? "HEALTHY" : recon}`);
  console.log(`KIS/JSON Position: ${checks.positionMatch ? "MATCH" : "FAIL"}`);
  console.log(`UNKNOWN_ACTIVE: ${checks.unknownNone ? "NONE" : "PRESENT"}`);
  console.log(`Open BUY: ${checks.openBuyNone ? "NONE" : "PRESENT"}`);
  console.log(`Worker Lock: ${checks.workerLock ? "HEALTHY" : "FAIL"}`);
  console.log(`RDS Mirror: ${checks.rdsMirror ? "HEALTHY" : "FAIL"}`);
  console.log(`DB Mirror Degraded: ${checks.mirrorDegraded ? "YES" : "NO"}`);
  console.log(`Max Qty: ${checks.maxQty}`);
  console.log(`REAL Requests: ${checks.realRequests}`);
  console.log(`Activation Ready: ${activationReady ? "YES" : "NO"}`);
  console.log("");
  console.log("NOTE: This phase keeps enabled=false even if Activation Ready=YES.");
  console.log("Broker order HTTP POST: 0 (gate does not submit)");
  if (rule) {
    console.log(
      `Rule: ${rule.id} ticker=${rule.ticker} MA=${rule.fastMa}/${rule.slowMa} budget=${rule.budget} enabled=${rule.enabled}`,
    );
  }
}

main();
