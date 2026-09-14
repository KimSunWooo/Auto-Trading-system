import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInitialState, ensureUniverseQuotes, portfolioValue, tickState } from "./engine";
import { getMarketClock } from "./market-hours";
import { cashFromAllocations, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { emptyCircuit } from "@/src/risk/circuit";
import { brokerDriver, getBrokerPublicStatus } from "@/src/brokers/kis-config";
import type { Allocation, AppState, Position, PublicState } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "paper-account.json");

let queue: Promise<unknown> = Promise.resolve();

function migrateState(parsed: AppState): AppState {
  const hasAllocations = Array.isArray(parsed.allocations) && parsed.allocations.length > 0;
  const allocations: Allocation[] = hasAllocations
    ? parsed.allocations.map((row) => ({
        strategy: row.strategy,
        riskLevel: row.riskLevel ?? 1,
        budget: row.budget,
        balance: row.balance,
        enabled: row.enabled ?? true,
        lastRunAt: row.lastRunAt,
        lastMessage: row.lastMessage,
        meta: row.meta ?? {},
      }))
    : [
        {
          strategy: "Level1_Stable",
          riskLevel: 1,
          budget: parsed.cash ?? TOTAL_DEPOSIT,
          balance: parsed.cash ?? TOTAL_DEPOSIT,
          enabled: true,
        },
        {
          strategy: "Level10_Aggressive",
          riskLevel: 10,
          budget: 0,
          balance: 0,
          enabled: true,
        },
      ];

  const positions: Position[] = (parsed.positions ?? []).map((p) => ({
    ...p,
    strategy: p.strategy ?? "Level1_Stable",
  }));

  const totalDeposit = parsed.totalDeposit ?? parsed.settings?.startingCash ?? TOTAL_DEPOSIT;

  return ensureUniverseQuotes({
    ...createInitialState(),
    ...parsed,
    settings: {
      ignoreMarketHours: parsed.settings?.ignoreMarketHours ?? true,
      startingCash: parsed.settings?.startingCash ?? totalDeposit,
      broker: brokerDriver(),
    },
    totalDeposit,
    allocations,
    positions,
    cash: cashFromAllocations(allocations),
    circuit: parsed.circuit ?? emptyCircuit(),
    lastEngineAt: parsed.lastEngineAt,
    lastBalanceSyncAt: parsed.lastBalanceSyncAt,
    kisBalance: parsed.kisBalance,
  });
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
    equity: portfolioValue(state),
    market: {
      timezone: "Asia/Seoul",
      now: clock.iso,
      open: clock.open,
      sessionLabel: clock.sessionLabel,
    },
    broker: getBrokerPublicStatus(),
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
