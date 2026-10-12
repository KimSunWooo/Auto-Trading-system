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
import { DatabaseLedgerError, persistTradingLedger } from "@/src/db/persist";
import { reconstituteAppStateFromLedger } from "@/src/db/reconstitute-state";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import {
  getWorkerProgress,
  nextTickId,
  recordWorkerProgress,
} from "@/src/runtime/worker-progress";
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
  mutateStore(
    fn: (state: AppState) => AppState | Promise<AppState>,
    mutateOpts?: { durable?: boolean; projectMode?: "tick" | "full" },
  ): Promise<AppState>;
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
  /** Account-scoped rules for projector — never bootstrap getRuleConfig. */
  getRuleConfig?: () => RuleConfigFile;
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

  type PersistJob = {
    state: AppState;
    /** Order/intent path — must not be coalesced away or reported success for another snapshot. */
    durable: boolean;
    projectMode: "tick" | "full";
  };

  let persistInflight: Promise<void> | null = null;
  /** Coalesce-only slot for non-durable tick/snapshot persists (latest wins). */
  let coalesceLatest: PersistJob | null = null;
  /** FIFO durable jobs — never dropped by a later coalesce snapshot. */
  const durableQueue: PersistJob[] = [];
  let persistTail: Promise<void> = Promise.resolve();

  async function flushLedgerOnce(job: PersistJob): Promise<void> {
    const next = job.state;
    const dbAuthority = isDatabaseLedgerAuthority();
    const persistStarted = Date.now();
    const tickId =
      brokerAccountId != null
        ? (getWorkerProgress(brokerAccountId)?.tickId ?? nextTickId(brokerAccountId))
        : `t-boot-${Date.now().toString(36)}`;
    if (brokerAccountId) {
      recordWorkerProgress(brokerAccountId, { stage: "persist_start", tickId });
    }
    try {
      if (dbAuthority) {
        // DB first — throw on failure so callers (KisBroker pre-submit persist) do not order.
        // Durable order path uses full projection; worker ticks use tick mode.
        await persistTradingLedger(
          next,
          { ...process.env, PERSISTENCE_MODE: "database" },
          {
            brokerAccountId,
            ruleConfig: opts.getRuleConfig?.(),
            projectMode: job.projectMode,
            txOpts: brokerAccountId
              ? {
                  onStage: (stage) => {
                    const mapped =
                      stage === "db_acquire"
                        ? "db_acquire"
                        : stage === "tx_begin"
                          ? "tx_begin"
                          : stage === "commit"
                            ? "commit"
                            : "project";
                    recordWorkerProgress(brokerAccountId, {
                      stage: mapped,
                      tickId:
                        getWorkerProgress(brokerAccountId)?.tickId ?? tickId,
                    });
                  },
                }
              : undefined,
          },
        );
        try {
          await repository.save(next);
        } catch (err) {
          console.error(
            "[trading-state-store] JSON cache save failed after DB commit:",
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        await repository.save(next);
        await mirrorAfterJsonSave(next, process.env, {
          brokerAccountId,
          ruleConfig: opts.getRuleConfig?.(),
          projectMode: job.projectMode,
        });
      }
      if (brokerAccountId) {
        const persistMs = Date.now() - persistStarted;
        recordWorkerProgress(brokerAccountId, {
          stage: "persist_done",
          tickId,
          persistMs,
          lastError: null,
        });
        console.info(
          `[ledger-persist] account=${brokerAccountId.slice(0, 8)} tickId=${tickId} stage=persist_done durable=${job.durable} mode=${job.projectMode} persistMs=${persistMs}`,
        );
      }
    } catch (err) {
      if (brokerAccountId) {
        const persistMs = Date.now() - persistStarted;
        recordWorkerProgress(brokerAccountId, {
          stage: "persist_failed",
          tickId,
          persistMs,
          lastError: err instanceof Error ? err.message : "ledger persist failed",
        });
        console.info(
          `[ledger-persist] account=${brokerAccountId.slice(0, 8)} tickId=${tickId} stage=persist_failed persistMs=${persistMs} err=${err instanceof Error ? err.message : "ledger persist failed"}`,
        );
      }
      throw err;
    }
  }

  async function saveState(
    state: AppState,
    saveOpts: { durable?: boolean; projectMode?: "tick" | "full" } = {},
  ): Promise<void> {
    if (opts.skipPersistUnderTest && isNodeTestProcess()) return;
    const durable = saveOpts.durable === true;
    const job: PersistJob = {
      state: mergePersistedControlledRun(state),
      durable,
      projectMode: saveOpts.projectMode ?? (durable ? "full" : "tick"),
    };
    if (durable) {
      durableQueue.push(job);
    } else {
      coalesceLatest = job;
    }
    const run = persistTail.then(async () => {
      while (durableQueue.length > 0 || coalesceLatest) {
        // Drain durable FIFO first so Intent/order commits are not replaced by a tick snapshot.
        const next = durableQueue.shift() ?? (() => {
          const c = coalesceLatest!;
          coalesceLatest = null;
          return c;
        })();
        await flushLedgerOnce(next);
      }
    });
    persistTail = run.then(
      () => undefined,
      () => undefined,
    );
    persistInflight = persistTail;
    try {
      await run;
    } finally {
      if (persistInflight === persistTail) persistInflight = null;
    }
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
    async mutateStore(fn, mutateOpts = {}) {
      return withStore(async (state) => {
        const next = await fn(state);
        next.updatedAt = new Date().toISOString();
        const durable = mutateOpts.durable === true;
        await saveState(next, {
          durable,
          projectMode: mutateOpts.projectMode ?? (durable ? "full" : "tick"),
        });
        return next;
      });
    },
    async persistStateNow(state) {
      // Durable: caller must observe DB commit of this book before broker submit.
      // Never succeed because a different coalesce snapshot flushed.
      await saveState(state, { durable: true, projectMode: "full" });
    },
    async tickAndGet(ruleConfig, tickOpts = {}) {
      const tickId = brokerAccountId
        ? nextTickId(brokerAccountId)
        : `t-boot-${Date.now().toString(36)}`;
      if (brokerAccountId) {
        recordWorkerProgress(brokerAccountId, { stage: "queue_enter", tickId });
        recordWorkerProgress(brokerAccountId, { stage: "tick_start", tickId });
      }
      try {
        const next = await store.mutateStore((state) =>
          tickState(state, new Date(), {
            ...tickOpts.tickDeps,
            ruleConfig: tickOpts.tickDeps?.ruleConfig ?? ruleConfig,
            kisClient: tickOpts.tickDeps?.kisClient ?? getKisClient?.(),
          }),
        );
        if (brokerAccountId) {
          recordWorkerProgress(brokerAccountId, {
            stage: "tick_done",
            tickId,
            lastError: null,
          });
        }
        return toPublicWithRules(next, ruleConfig, getKisClient, brokerAccountId);
      } catch (err) {
        if (brokerAccountId) {
          const prev = getWorkerProgress(brokerAccountId);
          if (prev?.stage !== "persist_failed") {
            recordWorkerProgress(brokerAccountId, {
              stage: "tick_failed",
              tickId,
              lastError: err instanceof Error ? err.message : "tick failed",
            });
          }
        }
        throw err;
      }
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
