import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "paper-account.json");

let queue: Promise<unknown> = Promise.resolve();

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
  });
  if (!merged.dayStart?.equity) {
    merged.dayStart = { date: seoulDay(), equity: accountValue(merged) };
  }
  return merged;
}

async function loadState(): Promise<AppState> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed.quotes || !parsed.settings) {
      return createInitialState();
    }
    return migrateState(parsed);
  } catch {
    return createInitialState();
  }
}

async function saveState(state: AppState) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(state, null, 2), "utf8");
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

export async function persistStateNow(state: AppState) {
  if (process.env.npm_lifecycle_event === "test") return;
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
  };
}

export async function getPublicState(): Promise<PublicState> {
  return withStore((state) => toPublic(state));
}

export async function tickAndGet(): Promise<PublicState> {
  const next = await mutateStore((state) => tickState(state));
  return toPublic(next);
}

export { STORE_PATH };
