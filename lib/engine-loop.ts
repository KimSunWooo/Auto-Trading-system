import { tickAndGet, mutateStore } from "@/lib/store";
import { HARD_LIMITS } from "@/src/risk/limits";
import { closeDb } from "@/src/db/client";
import { getSharedKisClient } from "@/src/brokers/kis-client";
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

const g = globalThis as typeof globalThis & {
  __mirimaesuEngine?: NodeJS.Timeout;
  __mirimaesuWorkerId?: string;
  __mirimaesuShuttingDown?: boolean;
  __mirimaesuSignalsBound?: boolean;
  __mirimaesuStartupSyncDone?: boolean;
  __mirimaesuStartupSyncPromise?: Promise<void>;
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
  g.__mirimaesuStartupSyncPromise = (async () => {
    let healthy = false;
    await mutateStore(async (state) => {
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
      if (!result.ok) {
        console.error("[engine-loop] startup sync FAILED:", result.error);
      } else {
        console.info(
          `[engine-loop] startup sync HEALTHY orphaned=${result.state.startupSync?.orphanedOrders ?? 0} recovered=${result.state.startupSync?.recoveredOrders ?? 0}`,
        );
      }
      return result.state;
    });
    // Only latch on success — FAILED/rate-limit retries on later ticks.
    if (healthy) g.__mirimaesuStartupSyncDone = true;
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
}

export function resetStartupSyncFlagForTest() {
  g.__mirimaesuStartupSyncDone = false;
  g.__mirimaesuStartupSyncPromise = undefined;
}
