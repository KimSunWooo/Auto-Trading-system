/**
 * Read-only overseas PAPER sync for server startup.
 * Never places orders. Never enables opt-in. Scoped separately from domestic Startup Sync.
 */
import type { AppState } from "@/lib/types";
import type { KisOverseasApi } from "@/src/brokers/kis-client";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import {
  classifyOverseasRestart,
  overseasServerStartupAutoOrderSafe,
} from "@/src/markets/overseas/lifecycle";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { overseasPaperOrdersLocked, vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { nowIso } from "@/src/clock";
import type { EnvMap } from "@/src/runtime/trading-mode";
import { usesPaperStartupSync } from "@/src/runtime/startup-sync";
import { safetyOf } from "@/src/runtime/safety";

export type OverseasSyncStatus = "IDLE" | "SYNCING" | "HEALTHY" | "FAILED" | "SKIPPED";

export type OverseasSyncState = {
  status: OverseasSyncStatus;
  lastSyncedAt?: string;
  openOrderCount: number;
  executionCount: number;
  positionCount: number;
  recoveryStatus?: string;
  blocksNewBuy?: boolean;
  message?: string;
  orderPosts: number;
};

export function emptyOverseasSync(): OverseasSyncState {
  return {
    status: "IDLE",
    openOrderCount: 0,
    executionCount: 0,
    positionCount: 0,
    orderPosts: 0,
  };
}

/** Same PAPER envelope as domestic startup sync; overseas path is additive only. */
export function usesOverseasPaperSync(env: EnvMap = process.env): boolean {
  return usesPaperStartupSync(env);
}

/**
 * Read-only reconcile. Does not mutate domestic startupSync status.
 * Failure here must not clear a HEALTHY domestic startupSync.
 */
export async function runOverseasPaperSync(
  state: AppState,
  client: KisOverseasApi,
  env: EnvMap = process.env,
): Promise<{ ok: boolean; state: AppState; sync: OverseasSyncState; error?: string }> {
  if (!overseasServerStartupAutoOrderSafe(env) || vtsOverseasOrderTestsEnabled(env)) {
    return {
      ok: false,
      state,
      sync: {
        ...emptyOverseasSync(),
        status: "FAILED",
        message: "RUN_KIS_VTS_OVERSEAS_ORDER_TESTS must stay unset during sync",
        orderPosts: 0,
      },
      error: "Overseas order opt-in must stay OFF",
    };
  }
  const locked = overseasPaperOrdersLocked(env);
  if (locked && /REAL/.test(locked)) {
    return {
      ok: false,
      state,
      sync: { ...emptyOverseasSync(), status: "FAILED", message: locked, orderPosts: 0 },
      error: locked,
    };
  }

  const adapter = new OverseasTradingAdapter(client);
  try {
    const openOrders = await adapter.getOpenOrders("NASDAQ");
    const nyseOpen = await adapter.getOpenOrders("NYSE").catch(() => []);
    const allOpen = [...openOrders, ...nyseOpen];
    const executions = await adapter.getExecutions();
    const { positions } = await adapter.getBalance("NASDAQ");
    const recovery = classifyOverseasRestart({
      localIntents: state.intents ?? [],
      localOrders: state.orders,
      openOrders: allOpen,
      executions,
    });
    const sync: OverseasSyncState = {
      status:
        recovery.status === "UNKNOWN_BLOCKING" || recovery.status === "MISMATCH"
          ? "FAILED"
          : "HEALTHY",
      lastSyncedAt: nowIso(),
      openOrderCount: allOpen.length,
      executionCount: executions.length,
      positionCount: positions.length,
      recoveryStatus: recovery.status,
      blocksNewBuy: recovery.blocksNewBuy,
      message: recovery.message,
      orderPosts: 0,
    };
    const prev = safetyOf(state);
    const next: AppState = {
      ...state,
      safety:
        sync.status === "FAILED"
          ? {
              ...prev,
              lastError: `overseas sync: ${sync.message}`,
              lastErrorAt: nowIso(),
            }
          : {
              ...prev,
              lastError: prev.lastError?.startsWith("overseas sync:") ? undefined : prev.lastError,
            },
    };
    void makeUsInstrument("NYSE", "F");
    return { ok: sync.status === "HEALTHY", state: next, sync };
  } catch (err) {
    const message = err instanceof Error ? err.message : "overseas sync failed";
    return {
      ok: false,
      state,
      sync: {
        ...emptyOverseasSync(),
        status: "FAILED",
        message,
        orderPosts: 0,
      },
      error: message,
    };
  }
}
