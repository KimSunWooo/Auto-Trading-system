import { tickAndGet } from "@/lib/store";
import { HARD_LIMITS } from "@/src/risk/limits";
import {
  heartbeatWorkerLock,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";

const g = globalThis as typeof globalThis & {
  __mirimaesuEngine?: NodeJS.Timeout;
  __mirimaesuWorkerId?: string;
};

function workerId(): string {
  g.__mirimaesuWorkerId ??= `engine-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return g.__mirimaesuWorkerId;
}

async function runTick() {
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
  void runTick().catch((err: unknown) => {
    console.error("[engine-loop]", err instanceof Error ? err.message : err);
  });
  g.__mirimaesuEngine = setInterval(() => {
    void runTick().catch((err: unknown) => {
      console.error("[engine-loop]", err instanceof Error ? err.message : err);
    });
  }, HARD_LIMITS.minTickMs);
}

export function stopEngineLoopForTest() {
  if (g.__mirimaesuEngine) clearInterval(g.__mirimaesuEngine);
  g.__mirimaesuEngine = undefined;
  if (g.__mirimaesuWorkerId) releaseWorkerLock(g.__mirimaesuWorkerId);
  g.__mirimaesuWorkerId = undefined;
}
