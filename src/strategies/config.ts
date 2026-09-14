import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import {
  DEFAULT_STRATEGY_CONFIG,
  asNumber,
  asUniverse,
  mergeLevel1,
  mergeLevel5,
  mergeLevel10,
  mergeStrategyConfig,
  overlayStrategyConfig,
  validateStrategyConfig,
  normalizeTicker,
  type Level1Params,
  type Level5Params,
  type Level10Params,
  type StrategyConfigFile,
} from "@/src/strategies/params";

export {
  mergeStrategyConfig,
  overlayStrategyConfig,
  validateStrategyConfig,
  normalizeTicker,
};

export const STRATEGY_CONFIG_PATH = path.join(process.cwd(), "data", "strategy-config.json");

type Meta = AccountBucket["meta"];

let cache: { mtimeMs: number; value: StrategyConfigFile } | null = null;
let testOverride: StrategyConfigFile | null = null;

function cloneConfig(value: StrategyConfigFile): StrategyConfigFile {
  return structuredClone(value);
}

function inTest() {
  return process.env.npm_lifecycle_event === "test";
}

function readFileConfig(): StrategyConfigFile {
  try {
    const raw = readFileSync(STRATEGY_CONFIG_PATH, "utf8");
    return mergeStrategyConfig(JSON.parse(raw) as unknown);
  } catch {
    return cloneConfig(DEFAULT_STRATEGY_CONFIG);
  }
}

function fileMtimeMs(): number {
  try {
    return statSync(STRATEGY_CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function seedFileIfMissing() {
  if (inTest()) return;
  try {
    statSync(STRATEGY_CONFIG_PATH);
  } catch {
    mkdirSync(path.dirname(STRATEGY_CONFIG_PATH), { recursive: true });
    writeFileSync(STRATEGY_CONFIG_PATH, `${JSON.stringify(DEFAULT_STRATEGY_CONFIG, null, 2)}\n`, "utf8");
  }
}

export function getStrategyConfig(): StrategyConfigFile {
  if (testOverride) return cloneConfig(testOverride);
  if (inTest()) return cloneConfig(DEFAULT_STRATEGY_CONFIG);
  seedFileIfMissing();
  const mtimeMs = fileMtimeMs();
  if (cache && cache.mtimeMs === mtimeMs) return cloneConfig(cache.value);
  const value = readFileConfig();
  cache = { mtimeMs, value };
  return cloneConfig(value);
}

export function saveStrategyConfig(raw: unknown): StrategyConfigFile {
  const next = mergeStrategyConfig(raw);
  const invalid = validateStrategyConfig(next);
  if (invalid) throw new Error(invalid);
  persistConfig(next);
  return cloneConfig(next);
}

export function patchStrategyConfig(raw: unknown): StrategyConfigFile {
  const next = overlayStrategyConfig(getStrategyConfig(), raw);
  const invalid = validateStrategyConfig(next);
  if (invalid) throw new Error(invalid);
  persistConfig(next);
  return cloneConfig(next);
}

function persistConfig(next: StrategyConfigFile) {
  if (!inTest()) {
    mkdirSync(path.dirname(STRATEGY_CONFIG_PATH), { recursive: true });
    writeFileSync(STRATEGY_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } else {
    testOverride = cloneConfig(next);
  }
  cache = { mtimeMs: fileMtimeMs() || Date.now(), value: next };
}

export function setStrategyConfigForTest(value: StrategyConfigFile | null) {
  testOverride = value ? cloneConfig(value) : null;
  cache = null;
}

export function resolveLevel1(meta: Meta = {}): Level1Params {
  return mergeLevel1(
    {
      ticker: typeof meta.ticker === "string" ? meta.ticker : undefined,
      intervalMs: asNumber(meta.intervalMs),
      sliceKrw: asNumber(meta.sliceKrw),
      slicePct: asNumber(meta.slicePct),
      minAmountKrw: asNumber(meta.minAmountKrw),
    },
    getStrategyConfig().Level1_Stable,
  );
}

export function resolveLevel5(meta: Meta = {}): Level5Params {
  return mergeLevel5(
    {
      ticker: typeof meta.ticker === "string" ? meta.ticker : undefined,
      fastMa: asNumber(meta.fastMa),
      slowMa: asNumber(meta.slowMa),
      buyPct: asNumber(meta.buyPct),
    },
    getStrategyConfig().Level5_Swing,
  );
}

export function resolveLevel10(meta: Meta = {}): Level10Params {
  return mergeLevel10(
    {
      universe: meta.universe,
      cooldownMs: asNumber(meta.cooldownMs),
      k: asNumber(meta.k),
      minDayReturn: asNumber(meta.minDayReturn),
      buyPct: asNumber(meta.buyPct),
    },
    getStrategyConfig().Level10_Aggressive,
  );
}

export function watchedStrategyTickers(allocations: Array<{ meta?: Meta }> = []): string[] {
  const cfg = getStrategyConfig();
  const codes = new Set<string>([
    cfg.Level1_Stable.ticker,
    cfg.Level5_Swing.ticker,
    ...cfg.Level10_Aggressive.universe,
  ]);
  for (const row of allocations) {
    const ticker = normalizeTicker(row.meta?.ticker);
    if (ticker) codes.add(ticker);
    for (const extra of asUniverse(row.meta?.universe) ?? []) codes.add(extra);
  }
  return [...codes];
}
