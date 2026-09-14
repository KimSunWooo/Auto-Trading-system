import { tickAndGet } from "@/lib/store";
import { HARD_LIMITS } from "@/src/risk/limits";

const g = globalThis as typeof globalThis & { __mirimaesuEngine?: NodeJS.Timeout };

export function startEngineLoop() {
  if (g.__mirimaesuEngine) return;
  g.__mirimaesuEngine = setInterval(() => {
    void tickAndGet().catch((err: unknown) => {
      console.error("[engine-loop]", err instanceof Error ? err.message : err);
    });
  }, HARD_LIMITS.minTickMs);
}
