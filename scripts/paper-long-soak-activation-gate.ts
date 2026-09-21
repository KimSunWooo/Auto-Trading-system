/**
 * PAPER Long Soak Activation Gate — PRE-ACTIVATION ONLY (read-only).
 * Never enables the rule. Never places orders. Never touches REAL.
 *
 * If the rule is already enabled, verdict is ALREADY_ENABLED (not a FAIL).
 * For armed/runtime checks use: scripts/paper-long-soak-runtime-health.ts
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
import {
  LONG_SOAK_RULE_ID,
  activationGateVerdict,
  formatActivationGateReport,
  workerRuntimeHealthy,
} from "@/src/runtime/paper-long-soak-health";

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

function main() {
  loadDotEnvLocal();
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("Refuse REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") {
    throw new Error("Refuse REAL mode");
  }
  delete process.env.KIS_LIVE_CONFIRM;

  const rules = getRuleConfig().rules;
  const rule = rules.find((row) => row.id === LONG_SOAK_RULE_ID);
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
  const workerLock = holdsWorkerLock() || workerLockHealthy();
  // Prefer runtime.worker when present on live state files; file snapshot may omit it.
  const runtimeWorker = (state as AppState & { runtime?: { worker?: string } }).runtime?.worker;
  const workerRuntimeOk =
    runtimeWorker == null ? workerLock : workerRuntimeHealthy(runtimeWorker);

  const prerequisitesOk =
    Boolean(rule) &&
    startup === "HEALTHY" &&
    quoteFresh &&
    dailyHistoryReady &&
    state.kisBalance != null &&
    (state.kisBalance.orderableCash ?? 0) > 0 &&
    recon === "HEALTHY" &&
    !posMismatch &&
    !unknown &&
    !openBuy &&
    workerLock &&
    workerRuntimeOk &&
    db.mode === "mirror" &&
    !mirrorDegraded &&
    PAPER_OPERATION_DEFAULTS.maxQtyPerOrder === 5;

  const verdict = activationGateVerdict({
    ruleExists: Boolean(rule),
    ruleEnabled: rule?.enabled === true,
    prerequisitesOk,
  });

  console.log(
    formatActivationGateReport({
      verdict,
      ruleExists: Boolean(rule),
      ruleEnabled: rule?.enabled === true,
      prerequisitesOk,
      details: {
        Market: marketOpen ? "OPEN" : "CLOSED",
        "Startup Sync": startup === "HEALTHY" ? "HEALTHY" : startup,
        "KIS Quote (obs <=120s)": quoteFresh ? "FRESH" : "FAIL",
        "Daily History": dailyHistoryReady ? "READY" : "FAIL",
        Balance: state.kisBalance != null ? "HEALTHY" : "FAIL",
        Orderable: (state.kisBalance?.orderableCash ?? 0) > 0 ? "HEALTHY" : "FAIL",
        Reconciliation: recon === "HEALTHY" ? "HEALTHY" : recon,
        "KIS/JSON Position": posMismatch ? "FAIL" : "MATCH",
        UNKNOWN_ACTIVE: unknown ? "PRESENT" : "NONE",
        "Open BUY": openBuy ? "PRESENT" : "NONE",
        "Worker Runtime": workerRuntimeOk ? "HEALTHY" : "FAIL",
        "Worker Lock": workerLock ? "HEALTHY" : "FAIL",
        "RDS Mirror": db.mode === "mirror" && !mirrorDegraded ? "HEALTHY" : "FAIL",
        "DB Mirror Degraded": mirrorDegraded ? "YES" : "NO",
        "Max Qty": String(PAPER_OPERATION_DEFAULTS.maxQtyPerOrder),
        "REAL Requests": "0",
      },
    }),
  );
  if (rule) {
    console.log(
      `Rule: ${rule.id} ticker=${rule.ticker} MA=${rule.fastMa}/${rule.slowMa} budget=${rule.budget} enabled=${rule.enabled}`,
    );
  }
  // Exit 0 for READY and ALREADY_ENABLED; 1 only when BLOCKED.
  if (verdict === "BLOCKED") process.exitCode = 1;
}

main();
