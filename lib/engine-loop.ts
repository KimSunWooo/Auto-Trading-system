import { tickAndGet } from "@/lib/store";
import { HARD_LIMITS } from "@/src/risk/limits";
import { closeDb } from "@/src/db/client";
import {
  heartbeatWorkerLock,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";

const g = globalThis as typeof globalThis & {
  __mirimaesuEngine?: NodeJS.Timeout;
  __mirimaesuWorkerId?: string;
  __mirimaesuShuttingDown?: boolean;
  __mirimaesuSignalsBound?: boolean;
};

function workerId(): string {
  g.__mirimaesuWorkerId ??= `engine-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return g.__mirimaesuWorkerId;
}

async function runTick() {
  if (g.__mirimaesuShuttingDown) return;
  const id = workerId();
  const locked = tryAcquireWorkerLock(id) || heartbeatWorkerLock();
  if (!locked) {
    console.error("[engine-loop] worker lock 미획득 — 이 프로세스는 주문을 실행하지 않습니다.");
    return;
  }
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
}
