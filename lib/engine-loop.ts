import { tickAndGet, mutateStore } from "@/lib/store";
import { HARD_LIMITS } from "@/src/risk/limits";
import { closeDb } from "@/src/db/client";
import { getSharedKisClient, type KisClient } from "@/src/brokers/kis-client";
import {
  heartbeatWorkerLock,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import {
  runPaperStartupSync,
  usesPaperStartupSync,
  emptyStartupSync,
} from "@/src/runtime/startup-sync";
import {
  runOverseasPaperSync,
  usesOverseasPaperSync,
} from "@/src/markets/overseas/sync";
import { overseasServerStartupAutoOrderSafe } from "@/src/markets/overseas/lifecycle";

const g = globalThis as typeof globalThis & {
  __mirimaesuEngine?: NodeJS.Timeout;
  __mirimaesuWorkerId?: string;
  __mirimaesuShuttingDown?: boolean;
  __mirimaesuSignalsBound?: boolean;
  __mirimaesuStartupSyncDone?: boolean;
  __mirimaesuStartupSyncPromise?: Promise<void>;
  __mirimaesuStartupSyncNextAttemptAt?: number;
  __mirimaesuOverseasSyncDone?: boolean;
};

function workerId(): string {
  g.__mirimaesuWorkerId ??= `engine-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return g.__mirimaesuWorkerId;
}

async function ensureStartupSync(): Promise<void> {
  if (!usesPaperStartupSync()) {
    g.__mirimaesuStartupSyncDone = true;
    return;
  }
  if (g.__mirimaesuStartupSyncDone) return;
  if (g.__mirimaesuStartupSyncPromise) {
    await g.__mirimaesuStartupSyncPromise;
    return;
  }
  const now = Date.now();
  if ((g.__mirimaesuStartupSyncNextAttemptAt ?? 0) > now) return;

  g.__mirimaesuStartupSyncPromise = (async () => {
    let healthy = false;
    let rateLimited = false;
    await mutateStore(async (state) => {
      if (state.startupSync?.status === "HEALTHY") {
        healthy = true;
        return state;
      }
      const marked = {
        ...state,
        startupSync: {
          ...(state.startupSync ?? emptyStartupSync()),
          status: "SYNCING" as const,
          message: "KIS PAPER Startup Sync starting before trading ticks",
        },
      };
      const client = getSharedKisClient();
      const result = await runPaperStartupSync(marked, client);
      healthy = result.ok && result.state.startupSync?.status === "HEALTHY";
      const err = result.error ?? result.state.startupSync?.message ?? "";
      rateLimited = /초당|EGW00201|rate/i.test(err);
      if (!result.ok) {
        console.error("[engine-loop] startup sync FAILED:", result.error);
      } else {
        console.info(
          `[engine-loop] startup sync HEALTHY orphaned=${result.state.startupSync?.orphanedOrders ?? 0} recovered=${result.state.startupSync?.recoveredOrders ?? 0}`,
        );
      }
      return result.state;
    });
    if (healthy) {
      g.__mirimaesuStartupSyncDone = true;
      g.__mirimaesuStartupSyncNextAttemptAt = undefined;
      // Additive overseas read-only sync. Never enables order opt-in. Never auto-orders.
      if (usesOverseasPaperSync() && overseasServerStartupAutoOrderSafe() && !g.__mirimaesuOverseasSyncDone) {
        try {
          await mutateStore(async (state) => {
            const client = getSharedKisClient() as KisClient;
            const overseas = await runOverseasPaperSync(state, client);
            if (overseas.ok) {
              g.__mirimaesuOverseasSyncDone = true;
              console.info(
                `[engine-loop] overseas sync HEALTHY open=${overseas.sync.openOrderCount} recovery=${overseas.sync.recoveryStatus}`,
              );
            } else {
              console.error("[engine-loop] overseas sync FAILED:", overseas.error ?? overseas.sync.message);
            }
            // Preserve domestic HEALTHY even when overseas fails.
            return {
              ...overseas.state,
              startupSync: state.startupSync,
            };
          });
        } catch (err) {
          console.error(
            "[engine-loop] overseas sync error (domestic untouched):",
            err instanceof Error ? err.message : err,
          );
        }
      }
    } else if (rateLimited) {
      // Avoid hammering KIS; retry after cooldown while keeping NEW ORDER blocked.
      g.__mirimaesuStartupSyncNextAttemptAt = Date.now() + 30_000;
      console.info("[engine-loop] startup sync rate-limited — retry in 30s");
    } else {
      g.__mirimaesuStartupSyncNextAttemptAt = Date.now() + 10_000;
    }
  })();
  try {
    await g.__mirimaesuStartupSyncPromise;
  } finally {
    g.__mirimaesuStartupSyncPromise = undefined;
  }
}

async function runTick() {
  if (g.__mirimaesuShuttingDown) return;
  const id = workerId();
  const locked = tryAcquireWorkerLock(id) || heartbeatWorkerLock();
  if (!locked) {
    console.error("[engine-loop] worker lock 미획득 — 이 프로세스는 주문을 실행하지 않습니다.");
    return;
  }
  await ensureStartupSync();
  await tickAndGet({ source: "worker" });
}

export function startEngineLoop() {
  if (g.__mirimaesuEngine) return;
  bindShutdownSignals();
  void runTick().catch((err: unknown) => {
    console.error("[engine-loop]", err instanceof Error ? err.message : err);
  });
  g.__mirimaesuEngine = setInterval(() => {
    void runTick().catch((err: unknown) => {
      console.error("[engine-loop]", err instanceof Error ? err.message : err);
    });
  }, HARD_LIMITS.minTickMs);
}

function bindShutdownSignals() {
  if (g.__mirimaesuSignalsBound) return;
  g.__mirimaesuSignalsBound = true;
  const onSignal = (signal: string) => {
    void gracefulShutdown(signal);
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

/**
 * Stop new ticks, release worker lock, close DB pool.
 * Does NOT flatten positions or cancel open orders.
 */
export async function gracefulShutdown(reason = "shutdown"): Promise<void> {
  if (g.__mirimaesuShuttingDown) return;
  g.__mirimaesuShuttingDown = true;
  console.info(`[engine-loop] graceful shutdown (${reason}) — no flatten`);
  if (g.__mirimaesuEngine) {
    clearInterval(g.__mirimaesuEngine);
    g.__mirimaesuEngine = undefined;
  }
  if (g.__mirimaesuWorkerId) {
    releaseWorkerLock(g.__mirimaesuWorkerId);
    g.__mirimaesuWorkerId = undefined;
  }
  await closeDb();
}

export function stopEngineLoopForTest() {
  if (g.__mirimaesuEngine) clearInterval(g.__mirimaesuEngine);
  g.__mirimaesuEngine = undefined;
  if (g.__mirimaesuWorkerId) releaseWorkerLock(g.__mirimaesuWorkerId);
  g.__mirimaesuWorkerId = undefined;
  g.__mirimaesuShuttingDown = false;
  g.__mirimaesuStartupSyncDone = false;
  g.__mirimaesuStartupSyncPromise = undefined;
  g.__mirimaesuOverseasSyncDone = false;
}

export function resetStartupSyncFlagForTest() {
  g.__mirimaesuStartupSyncDone = false;
  g.__mirimaesuStartupSyncPromise = undefined;
  g.__mirimaesuOverseasSyncDone = false;
}
