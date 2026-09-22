/**
 * Per-account trading state store — own queue, no global mutable path swap.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInitialState, accountValue, tickState, type TickRuntimeDeps } from "@/lib/engine";
import { getMarketClock } from "@/lib/market-hours";
import type { AppState, PublicState } from "@/lib/types";
import { JsonStateRepository } from "@/src/persistence/json-state-repository";
import { hydratePersistedState, toPublic as bootstrapToPublic } from "@/lib/store";
import { mirrorAfterJsonSave } from "@/src/db/mirror";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import type { RuleConfigFile } from "@/src/rules/params";
import { getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { buildRuntimePublic } from "@/src/runtime/status";
import type { KisApi } from "@/src/brokers/kis-client";

export type TradingStateStore = {
  readonly statePath: string;
  getState(): Promise<AppState>;
  getPublicState(ruleConfig: RuleConfigFile): Promise<PublicState>;
  toPublic(state: AppState, ruleConfig: RuleConfigFile): PublicState;
  mutateStore(fn: (state: AppState) => AppState | Promise<AppState>): Promise<AppState>;
  persistStateNow(state: AppState): Promise<void>;
  tickAndGet(
    ruleConfig: RuleConfigFile,
    opts?: { source?: "http" | "worker"; tickDeps?: TickRuntimeDeps },
  ): Promise<PublicState>;
};

const stores = new Map<string, TradingStateStore>();

function toPublicWithRules(state: AppState, ruleConfig: RuleConfigFile): PublicState {
  const clock = getMarketClock();
  return {
    ...state,
    equity: accountValue(state),
    market: {
      timezone: "Asia/Seoul",
      now: clock.iso,
      open: clock.open,
      sessionLabel: clock.sessionLabel,
    },
    broker: getBrokerPublicStatus(),
    ruleConfig,
    runtime: buildRuntimePublic(state),
  };
}

export function createTradingStateStore(opts: {
  statePath: string;
  /** When true, skip writes under node:test (matches bootstrap DEFAULT_STORE_PATH behavior). */
  skipPersistUnderTest?: boolean;
}): TradingStateStore {
  const absolute = path.isAbsolute(opts.statePath)
    ? opts.statePath
    : path.join(process.cwd(), opts.statePath);
  const existing = stores.get(absolute);
  if (existing) return existing;

  const repository = new JsonStateRepository(absolute);
  let queue: Promise<unknown> = Promise.resolve();

  async function loadState(): Promise<AppState> {
    return hydratePersistedState(await repository.load());
  }

  function mergePersistedControlledRun(incoming: AppState): AppState {
    try {
      const prev = JSON.parse(readFileSync(absolute, "utf8")) as AppState;
      if (prev.controlledRun && !incoming.controlledRun) {
        return { ...incoming, controlledRun: prev.controlledRun };
      }
      return incoming;
    } catch {
      return incoming;
    }
  }

  async function saveState(state: AppState): Promise<void> {
    if (opts.skipPersistUnderTest && isNodeTestProcess()) return;
    const next = mergePersistedControlledRun(state);
    await repository.save(next);
    await mirrorAfterJsonSave(next);
  }

  function withStore<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => fn(await loadState()));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const store: TradingStateStore = {
    statePath: absolute,
    getState: () => withStore((s) => s),
    async getPublicState(ruleConfig) {
      return withStore((state) => toPublicWithRules(state, ruleConfig));
    },
    toPublic(state, ruleConfig) {
      return toPublicWithRules(state, ruleConfig);
    },
    async mutateStore(fn) {
      return withStore(async (state) => {
        const next = await fn(state);
        next.updatedAt = new Date().toISOString();
        await saveState(next);
        return next;
      });
    },
    async persistStateNow(state) {
      await saveState(state);
    },
    async tickAndGet(ruleConfig, tickOpts = {}) {
      const next = await store.mutateStore((state) =>
        tickState(state, new Date(), {
          ...tickOpts.tickDeps,
          ruleConfig: tickOpts.tickDeps?.ruleConfig ?? ruleConfig,
        }),
      );
      return toPublicWithRules(next, ruleConfig);
    },
  };

  stores.set(absolute, store);
  return store;
}

export function resetTradingStateStoresForTest(): void {
  stores.clear();
}

/** Re-export bootstrap toPublic for callers that still use global store. */
export { bootstrapToPublic };
