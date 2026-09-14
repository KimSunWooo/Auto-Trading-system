import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInitialState, portfolioValue, tickState } from "./engine";
import { getMarketClock } from "./market-hours";
import type { AppState, PublicState } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "paper-account.json");

let queue: Promise<unknown> = Promise.resolve();

async function loadState(): Promise<AppState> {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as AppState;
    if (!parsed.quotes || !parsed.settings) {
      return createInitialState();
    }
    return parsed;
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
