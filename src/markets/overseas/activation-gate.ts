import type { EnvMap } from "@/src/runtime/trading-mode";
import { overseasPaperOrdersLocked, vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { overseasVtsBEnvironment } from "@/src/markets/overseas/preflight";
import {
  overseasQuoteOrderableGate,
  overseasFirstLifecycleQtyOk,
  classifyOverseasRestart,
  OVERSEAS_FIRST_LIFECYCLE_QTY,
} from "@/src/markets/overseas/lifecycle";
import { overseasUsdOrderableOk } from "@/src/markets/overseas/preflight";
import type { OverseasQuote } from "@/src/markets/overseas/types";
import type { OverseasRecoveryResult } from "@/src/markets/overseas/lifecycle";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { holdsWorkerLock, workerLockHealthy } from "@/src/runtime/worker-lock";
import { workerRuntimeHealthy, workerRuntimeStatus } from "@/src/runtime/paper-long-soak-health";

export type OverseasActivationGateResult = {
  ok: boolean;
  blocked: string | null;
  runtime: "READY" | "WAITING FOR MARKET" | "BLOCKED";
  checks: Record<string, "PASS" | "FAIL" | "OFF" | "WAITING">;
  firstLifecycleQty: number;
  fxExecutionApi: string;
  recovery?: OverseasRecoveryResult;
};

/**
 * Server-start Activation Gate for the first overseas PAPER 1-share lifecycle.
 * Does not place orders. Opt-in must stay OFF during preparation.
 *
 * Worker / RDS must come from real runtime — hardcoded true is rejected.
 */
export function overseasActivationGate(input: {
  env?: EnvMap;
  quote: OverseasQuote | null;
  usdCash: number | null;
  usdOrderable: number | null;
  orderableQty: number | null;
  presentBalanceOk: boolean;
  positionsOk: boolean;
  openOrdersOk: boolean;
  executionsOk: boolean;
  recovery: OverseasRecoveryResult;
  existingOpenBuy: boolean;
  unknownPresent: boolean;
  paperOrderPosts?: number;
  realRequests?: number;
  /** runtime.worker string — must be exactly "healthy". undefined/unknown ≠ PASS. */
  runtimeWorker?: string | null;
  /** When set, used instead of probing the lock file (scripts pass measured value). */
  workerLockOk?: boolean;
  /** @deprecated Prefer runtimeWorker. Boolean true without runtimeWorker is ignored. */
  workerHealthy?: boolean;
  persistenceHealthy?: boolean;
  /** Ignored when set to true without verifying publicDatabaseStatus — RDS is always re-checked. */
  rdsMirrorHealthy?: boolean;
}): OverseasActivationGateResult {
  const env = input.env ?? process.env;
  const envCheck = overseasVtsBEnvironment(env);
  const quoteGate = overseasQuoteOrderableGate(input.quote);
  const qtyOk = overseasFirstLifecycleQtyOk(OVERSEAS_FIRST_LIFECYCLE_QTY);
  const orderableOk = overseasUsdOrderableOk(input.usdOrderable);
  const orderableQtyOk = (input.orderableQty ?? 0) >= 1 || orderableOk;
  const optInOff = !vtsOverseasOrderTestsEnabled(env);
  const locked = overseasPaperOrdersLocked(env);
  const db = publicDatabaseStatus(env);
  const mirrorDegraded = Boolean(db.lastError?.includes("DB_MIRROR_DEGRADED"));
  // Always derive RDS from authoritative status — never trust caller hardcoded true.
  const rdsOk =
    db.mode === "mirror" &&
    (db.enabled === true || db.connected === true) &&
    !mirrorDegraded &&
    input.rdsMirrorHealthy !== false;

  const workerRuntimeOk = workerRuntimeHealthy(input.runtimeWorker);
  const workerLockOk =
    input.workerLockOk ?? (holdsWorkerLock() || workerLockHealthy());
  // Reject legacy workerHealthy:true when runtimeWorker is missing/unknown.
  const workerOk = workerRuntimeOk && workerLockOk && input.workerHealthy !== false;

  const posts = input.paperOrderPosts ?? 0;
  const real = input.realRequests ?? 0;

  const checks: Record<string, "PASS" | "FAIL" | "OFF" | "WAITING"> = {
    environment: envCheck.environment ? "PASS" : "FAIL",
    realFlags: envCheck.realDisabled ? "PASS" : "FAIL",
    orderOptIn: optInOff ? "OFF" : "FAIL",
    quote: quoteGate.ok || quoteGate.mode === "market_closed" ? (quoteGate.ok ? "PASS" : "WAITING") : "FAIL",
    quoteSource: input.quote?.source === "kis" ? "PASS" : "FAIL",
    marketStatus: input.quote?.marketStatus === "open" ? "PASS" : "WAITING",
    quoteOrderable:
      quoteGate.mode === "explicit_false"
        ? "FAIL"
        : quoteGate.ok
          ? "PASS"
          : quoteGate.mode === "market_closed"
            ? "WAITING"
            : "FAIL",
    presentBalance: input.presentBalanceOk ? "PASS" : "FAIL",
    usdOrderable: orderableOk ? "PASS" : "FAIL",
    orderableQty: orderableQtyOk ? "PASS" : "FAIL",
    positions: input.positionsOk ? "PASS" : "FAIL",
    openOrders: input.openOrdersOk ? "PASS" : "FAIL",
    executions: input.executionsOk ? "PASS" : "FAIL",
    reconciliation:
      input.recovery.status === "HEALTHY" || input.recovery.status === "EXECUTION_MATCHED"
        ? "PASS"
        : "FAIL",
    unknown: input.unknownPresent || input.recovery.status === "UNKNOWN_BLOCKING" ? "FAIL" : "PASS",
    existingBuy: input.existingOpenBuy || input.recovery.blocksNewBuy ? "FAIL" : "PASS",
    workerRuntime: workerRuntimeOk ? "PASS" : "FAIL",
    workerLock: workerLockOk ? "PASS" : "FAIL",
    worker: workerOk ? "PASS" : "FAIL",
    persistence: input.persistenceHealthy === false ? "FAIL" : "PASS",
    rdsMirror: rdsOk ? "PASS" : "FAIL",
    orderPosts: posts === 0 ? "PASS" : "FAIL",
    realRequests: real === 0 ? "PASS" : "FAIL",
    firstQty: qtyOk.ok ? "PASS" : "FAIL",
  };

  let blocked: string | null = null;
  if (!envCheck.realDisabled) blocked = envCheck.blocked;
  else if (!envCheck.environment) blocked = envCheck.blocked;
  else if (!optInOff) blocked = "Overseas order opt-in must stay OFF during preparation";
  else if (locked && /REAL/.test(locked)) blocked = locked;
  else if (!quoteGate.ok && quoteGate.mode !== "market_closed") blocked = quoteGate.blocked;
  else if (!orderableOk) blocked = "USD orderable amount is 0";
  else if (!input.presentBalanceOk) blocked = "Present balance unhealthy";
  else if (!input.positionsOk) blocked = "Positions inquiry unhealthy";
  else if (!input.openOrdersOk) blocked = "Open orders inquiry unhealthy";
  else if (!input.executionsOk) blocked = "Executions inquiry unhealthy";
  else if (input.recovery.blocksNewBuy && input.recovery.status !== "HEALTHY") {
    blocked = input.recovery.message;
  } else if (input.unknownPresent) blocked = "UNKNOWN overseas order present";
  else if (input.existingOpenBuy) blocked = "Existing open BUY";
  else if (!workerRuntimeOk) {
    blocked = `Worker runtime ${workerRuntimeStatus(input.runtimeWorker)} — not healthy`;
  } else if (!workerLockOk) blocked = "Worker lock unhealthy";
  else if (!rdsOk) blocked = mirrorDegraded ? "RDS mirror degraded" : "RDS mirror not healthy";
  else if (input.persistenceHealthy === false) blocked = "Persistence unhealthy";
  else if (posts !== 0) blocked = "Unexpected PAPER order POST";
  else if (real !== 0) blocked = "REAL HTTP request observed";

  const waitingMarket =
    blocked == null &&
    (input.quote?.marketStatus !== "open" || quoteGate.mode === "market_closed");

  const runtime: OverseasActivationGateResult["runtime"] = blocked
    ? "BLOCKED"
    : waitingMarket
      ? "WAITING FOR MARKET"
      : "READY";

  return {
    ok: blocked == null && !waitingMarket,
    blocked: blocked ?? (waitingMarket ? "WAITING FOR MARKET" : null),
    runtime,
    checks,
    firstLifecycleQty: OVERSEAS_FIRST_LIFECYCLE_QTY,
    fxExecutionApi: KIS_CURRENCY_EXCHANGE_AUDIT.paperVtsExecutionSupported,
    recovery: input.recovery,
  };
}

export function emptyOverseasRecovery(): OverseasRecoveryResult {
  return classifyOverseasRestart({
    localOrders: [],
    openOrders: [],
    executions: [],
  });
}
