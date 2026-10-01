/**
 * Per-account trading state store — own queue, no global mutable path swap.
 * Public broker status prefers the account RuntimeScope KisClient over process.env.
 *
 * PERSISTENCE_MODE=database: DB is trading-ledger authority. JSON is optional cache.
 * Restart recovery can reconstitute from DB when state.json is missing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { accountValue, tickState, type TickRuntimeDeps } from "@/lib/engine";
import { getMarketClock } from "@/lib/market-hours";
import type { AppState, BrokerPublicStatus, PublicState } from "@/lib/types";
import { JsonStateRepository } from "@/src/persistence/json-state-repository";
import { hydratePersistedState, toPublic as bootstrapToPublic } from "@/lib/store";
import { mirrorAfterJsonSave, resolveMirrorLedger } from "@/src/db/mirror";
import { isDatabaseLedgerAuthority } from "@/src/db/config";
import { DatabaseLedgerError } from "@/src/db/persist";
import { reconstituteAppStateFromLedger } from "@/src/db/reconstitute-state";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import type { RuleConfigFile } from "@/src/rules/params";
import {
  brokerPublicStatusFromKisClient,
  getBrokerPublicStatus,
} from "@/src/brokers/kis-config";
import { buildRuntimePublic } from "@/src/runtime/status";
import type { KisApi } from "@/src/brokers/kis-client";

export type TradingStateStore = {
  readonly statePath: string;
  readonly brokerAccountId?: string;
  /** Rebind account KisClient authority (RuntimeScope rebuild / credential rotate). */
  bindKisClient(getKisClient: () => KisApi | undefined): void;
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

type StoreInternal = TradingStateStore & {
  _getKisClient: () => KisApi | undefined;
};

const stores = new Map<string, StoreInternal>();

function brokerAccountIdFromStatePath(statePath: string): string | undefined {
  // .../data/accounts/<uuid>/state.json
  const parts = statePath.split(path.sep);
  const idx = parts.lastIndexOf("accounts");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return undefined;
}

function resolveBrokerPublicStatus(getKisClient?: () => KisApi | undefined): BrokerPublicStatus {
  const client = getKisClient?.();
  if (client) return brokerPublicStatusFromKisClient(client);
  // Bootstrap / tests without a bound scope still report KIS-only (never mock).
  return getBrokerPublicStatus();
}

function toPublicWithRules(
  state: AppState,
  ruleConfig: RuleConfigFile,
  getKisClient?: () => KisApi | undefined,
  brokerAccountId?: string,
): PublicState {
  const clock = getMarketClock();
  const broker = resolveBrokerPublicStatus(getKisClient);
  return {
    ...state,
    equity: accountValue(state),
    market: {
      timezone: "Asia/Seoul",
      now: clock.iso,
      open: clock.open,
      sessionLabel: clock.sessionLabel,
    },
    broker,
    ruleConfig,
    runtime: buildRuntimePublic(state, { broker, brokerAccountId }),
  };
}

export function createTradingStateStore(opts: {
  statePath: string;
  brokerAccountId?: string;
  /** When true, skip writes under node:test (matches bootstrap DEFAULT_STORE_PATH behavior). */
  skipPersistUnderTest?: boolean;
  /**
   * Account-scoped KisClient lookup. When present, public broker status never
   * falls back to a different global env account.
   */
  getKisClient?: () => KisApi | undefined;
}): TradingStateStore {
  const absolute = path.isAbsolute(opts.statePath)
    ? opts.statePath
    : path.join(process.cwd(), opts.statePath);
  const existing = stores.get(absolute);
  if (existing) {
    if (opts.getKisClient) existing.bindKisClient(opts.getKisClient);
    return existing;
  }

  const repository = new JsonStateRepository(absolute);
  const brokerAccountId = opts.brokerAccountId ?? brokerAccountIdFromStatePath(absolute);
  let queue: Promise<unknown> = Promise.resolve();
  let getKisClient = opts.getKisClient;

  async function loadState(): Promise<AppState> {
    const loaded = await repository.load();
    if (loaded.ok) {
      return hydratePersistedState(loaded);
    }
    if (isDatabaseLedgerAuthority() && brokerAccountId) {
      const ledger = await resolveMirrorLedger();
      if (ledger) {
        try {
          return await reconstituteAppStateFromLedger(ledger, brokerAccountId);
        } catch (err) {
          console.error(
            `[trading-state-store] DB reconstitute failed for ${brokerAccountId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return hydratePersistedState(loaded);
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
    const dbAuthority = isDatabaseLedgerAuthority();

    if (dbAuthority) {
      // DB first — throw on failure so callers (KisBroker pre-submit persist) do not order.
      await mirrorAfterJsonSave(next, process.env, {
        brokerAccountId,
      });
      try {
        await repository.save(next);
      } catch (err) {
        console.error(
          "[trading-state-store] JSON cache save failed after DB commit:",
          err instanceof Error ? err.message : err,
        );
      }
      return;
    }

    await repository.save(next);
    await mirrorAfterJsonSave(next, process.env, {
      brokerAccountId,
    });
  }

  function withStore<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => fn(await loadState()));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const store: StoreInternal = {
    statePath: absolute,
    brokerAccountId,
    _getKisClient: () => getKisClient?.(),
    bindKisClient(next) {
      getKisClient = next;
      store._getKisClient = () => getKisClient?.();
    },
    getState: () => withStore((s) => s),
    async getPublicState(ruleConfig) {
      return withStore((state) =>
        toPublicWithRules(state, ruleConfig, getKisClient, brokerAccountId),
      );
    },
    toPublic(state, ruleConfig) {
      return toPublicWithRules(state, ruleConfig, getKisClient, brokerAccountId);
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
          kisClient: tickOpts.tickDeps?.kisClient ?? getKisClient?.(),
        }),
      );
      return toPublicWithRules(next, ruleConfig, getKisClient, brokerAccountId);
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

export { DatabaseLedgerError };
