import path from "node:path";
import { readFileSync } from "node:fs";
import { createInitialState, ensureUniverseQuotes, accountValue, tickState } from "./engine";
import { getMarketClock } from "./market-hours";
import { cashFromAllocations, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { emptyCircuit } from "@/src/risk/circuit";
import { seoulDay } from "@/src/risk/limits";
import { mergeProductRisk } from "@/src/risk/product";
import { brokerDriver, getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { cashAllocation, getRuleConfig } from "@/src/rules/config";
import { CASH_RULE_ID, isLegacyPlaybookId } from "@/src/rules/params";
import type { Allocation, AppState, Position, PublicState } from "./types";
import { JsonStateRepository } from "@/src/persistence/json-state-repository";
import { emptySafety, safetyOf, blockSafety } from "@/src/runtime/safety";
import { httpTickAllowed, isLiveLike } from "@/src/runtime/trading-mode";
import { holdsWorkerLock } from "@/src/runtime/worker-lock";
import { buildRuntimePublic } from "@/src/runtime/status";
import { mirrorAfterJsonSave } from "@/src/db/mirror";

const DATA_DIR = path.join(process.cwd(), "data");
export const DEFAULT_STORE_PATH = path.join(DATA_DIR, "paper-account.json");

/** Optional test-only override. Unset in production so the paper book is unchanged. */
export function resolveStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRADING_STATE_PATH?.trim();
  if (!override) return DEFAULT_STORE_PATH;
  if (path.isAbsolute(override)) return override;
  const underData = override.replace(/^data\/?/, "");
  return path.join(process.cwd(), "data", underData);
}

let activeStorePath = resolveStorePath();
let repository = new JsonStateRepository(activeStorePath);

let queue: Promise<unknown> = Promise.resolve();

export function currentStorePath(): string {
  return activeStorePath;
}

export function configureStateStore(filePath: string): void {
  activeStorePath = filePath;
  repository = new JsonStateRepository(filePath);
  queue = Promise.resolve();
}

export function resetStateStoreForTest(): void {
  configureStateStore(resolveStorePath());
}

function asRuleId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  if (!id || isLegacyPlaybookId(id)) return CASH_RULE_ID;
  return id;
}

function migrateState(parsed: AppState): AppState {
  type LegacyAlloc = Allocation & { strategy?: string };
  type LegacyPos = Position & { strategy?: string };
  const rawAllocs = (Array.isArray(parsed.allocations) ? parsed.allocations : []) as LegacyAlloc[];
  const folded = rawAllocs.filter((row) => !isLegacyPlaybookId(row.ruleId ?? row.strategy));
  const leftover = rawAllocs
    .filter((row) => isLegacyPlaybookId(row.ruleId ?? row.strategy))
    .reduce((sum, row) => sum + (row.balance ?? 0), 0);
  const allocations: Allocation[] =
    folded.length > 0
      ? folded.map((row) => ({
          ruleId: asRuleId(row.ruleId ?? row.strategy),
          budget: row.budget,
          balance: row.balance,
          enabled: row.enabled ?? true,
          lastRunAt: row.lastRunAt,
          lastMessage: row.lastMessage,
          meta: row.meta ?? {},
        }))
      : [cashAllocation(parsed.totalDeposit ?? parsed.settings?.startingCash ?? TOTAL_DEPOSIT)];

  if (!allocations.some((row) => row.ruleId === CASH_RULE_ID) && leftover > 0) {
    allocations.unshift(cashAllocation(leftover, leftover));
  }

  const positions: Position[] = ((parsed.positions ?? []) as LegacyPos[]).map((p) => ({
    code: p.code,
    name: p.name,
    qty: p.qty,
    avgPrice: p.avgPrice,
    ruleId: asRuleId(p.ruleId ?? p.strategy),
  }));

  const totalDeposit = parsed.totalDeposit ?? parsed.settings?.startingCash ?? TOTAL_DEPOSIT;
  const disclaimerAccepted = Boolean(parsed.settings?.disclaimerAccepted);
  const merged = ensureUniverseQuotes({
    ...createInitialState(),
    ...parsed,
    settings: {
      ignoreMarketHours: parsed.settings?.ignoreMarketHours ?? true,
      startingCash: parsed.settings?.startingCash ?? totalDeposit,
      broker: brokerDriver(),
      autoTrading: disclaimerAccepted && (parsed.settings?.autoTrading ?? false),
      onboardingComplete: parsed.settings?.onboardingComplete ?? false,
      liquidating: false,
      disclaimerAccepted,
      disclaimerAcceptedAt: parsed.settings?.disclaimerAcceptedAt,
      risk: mergeProductRisk(parsed.settings?.risk),
    },
    totalDeposit,
    allocations,
    positions,
    cash: cashFromAllocations(allocations),
    circuit: parsed.circuit ?? emptyCircuit(),
    lastEngineAt: parsed.lastEngineAt,
    lastBalanceSyncAt: parsed.lastBalanceSyncAt,
    kisBalance: parsed.kisBalance,
    dayStart: parsed.dayStart ?? { date: seoulDay(), equity: totalDeposit },
    equityHistory: parsed.equityHistory ?? [totalDeposit],
    intents: parsed.intents ?? [],
    safety: parsed.safety ?? emptySafety(),
  });
  if (!merged.dayStart?.equity) {
    merged.dayStart = { date: seoulDay(), equity: accountValue(merged) };
  }
  return merged;
}

export function hydratePersistedState(
  loaded: Awaited<ReturnType<JsonStateRepository["load"]>>,
): AppState {
  if (!loaded.ok && loaded.reason === "missing") {
    return createInitialState();
  }
  if (!loaded.ok) {
    const blocked = createInitialState();
    blocked.settings.autoTrading = false;
    return blockSafety(
      blocked,
      "store_corrupt",
      "장부 JSON이 손상되어 초기화하지 않고 매매를 막았습니다.",
      { persistable: false, tradingAllowed: false },
    );
  }
  const parsed = loaded.value;
  if (!parsed.quotes || !parsed.settings) {
    const blocked = createInitialState();
    blocked.settings.autoTrading = false;
    return blockSafety(
      blocked,
      "store_corrupt",
      "장부 형식이 올바르지 않아 초기화하지 않고 매매를 막았습니다.",
      { persistable: false, tradingAllowed: false },
    );
  }
  const migrated = migrateState(parsed);
  if (loaded.source === "backup") {
    return {
      ...migrated,
      safety: {
        ...safetyOf(migrated),
        lastError: "백업 장부에서 복구했습니다.",
        lastErrorAt: new Date().toISOString(),
      },
    };
  }
  return migrated;
}

async function loadState(): Promise<AppState> {
  return hydratePersistedState(await repository.load());
}

function mergePersistedControlledRun(incoming: AppState): AppState {
  try {
    const prev = JSON.parse(readFileSync(activeStorePath, "utf8")) as AppState;
    if (prev.controlledRun && !incoming.controlledRun) {
      return { ...incoming, controlledRun: prev.controlledRun };
    }
    return incoming;
  } catch {
    return incoming;
  }
}

async function saveState(state: AppState) {
  const next = mergePersistedControlledRun(state);
  await repository.save(next);
  await mirrorAfterJsonSave(next);
}

export function withStore<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const state = await loadState();
    return fn(state);
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function mutateStore(
  fn: (state: AppState) => AppState | Promise<AppState>,
): Promise<AppState> {
  return withStore(async (state) => {
    const next = await fn(state);
    next.updatedAt = new Date().toISOString();
    await saveState(next);
    return next;
  });
}

/** Production paper book is not written during `npm test`. Isolated VTS paths still persist. */
export async function persistStateNow(state: AppState) {
  const testingDefaultBook =
    process.env.npm_lifecycle_event === "test" && activeStorePath === DEFAULT_STORE_PATH;
  if (testingDefaultBook) return;
  await saveState(state);
}

export function toPublic(state: AppState): PublicState {
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
    ruleConfig: getRuleConfig(),
    runtime: buildRuntimePublic(state),
  };
}

export async function getPublicState(): Promise<PublicState> {
  return withStore((state) => toPublic(state));
}

export async function tickAndGet(
  opts: { source?: "http" | "worker" } = {},
): Promise<PublicState> {
  const source = opts.source ?? "worker";
  if (source === "http" && !httpTickAllowed()) {
    return getPublicState();
  }
  if (source === "worker" && isLiveLike() && !holdsWorkerLock()) {
    return getPublicState();
  }
  const next = await mutateStore((state) => tickState(state));
  return toPublic(next);
}

export const STORE_PATH = DEFAULT_STORE_PATH;
