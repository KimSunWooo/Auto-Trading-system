import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import {
  DEFAULT_STRATEGY_CONFIG,
  type Level1Params,
  type Level5Params,
  type Level10Params,
  type StrategyConfigFile,
} from "@/src/strategies/params";

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

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asPositive(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n > 0 ? n : undefined;
}

function asUnitInterval(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n >= 0 && n <= 1 ? n : undefined;
}

export function normalizeTicker(value: unknown): string | undefined {
  const digits = String(value ?? "").replace(/\D/g, "").slice(-6).padStart(6, "0");
  if (!/^\d{6}$/.test(digits) || digits === "000000") return undefined;
  return digits;
}

function asUniverse(value: unknown): string[] | undefined {
  let raw: string[] = [];
  if (Array.isArray(value)) raw = value.map((row) => String(row));
  else if (typeof value === "string") raw = value.split(/[,\s]+/);
  const tickers = [...new Set(raw.map((row) => normalizeTicker(row)).filter((row): row is string => Boolean(row)))];
  return tickers.length > 0 ? tickers : undefined;
}

function mergeLevel1(raw: Partial<Level1Params> | undefined, fallback: Level1Params): Level1Params {
  return {
    ticker: normalizeTicker(raw?.ticker) ?? fallback.ticker,
    intervalMs: Math.round(asPositive(raw?.intervalMs) ?? fallback.intervalMs),
    sliceKrw: Math.round(asPositive(raw?.sliceKrw) ?? fallback.sliceKrw),
    slicePct: asUnitInterval(raw?.slicePct) ?? fallback.slicePct,
    minAmountKrw: Math.round(asPositive(raw?.minAmountKrw) ?? fallback.minAmountKrw),
  };
}

function mergeLevel5(raw: Partial<Level5Params> | undefined, fallback: Level5Params): Level5Params {
  const fastMa = Math.round(asPositive(raw?.fastMa) ?? fallback.fastMa);
  const slowMa = Math.round(asPositive(raw?.slowMa) ?? fallback.slowMa);
  return {
    ticker: normalizeTicker(raw?.ticker) ?? fallback.ticker,
    fastMa,
    slowMa,
    buyPct: asUnitInterval(raw?.buyPct) ?? fallback.buyPct,
  };
}

function mergeLevel10(raw: { universe?: unknown; cooldownMs?: number; k?: number; minDayReturn?: number; buyPct?: number } | undefined, fallback: Level10Params): Level10Params {
  return {
    universe: asUniverse(raw?.universe) ?? [...fallback.universe],
    cooldownMs: Math.round(asNumber(raw?.cooldownMs) ?? fallback.cooldownMs),
    k: asPositive(raw?.k) ?? fallback.k,
    minDayReturn: asUnitInterval(raw?.minDayReturn) ?? fallback.minDayReturn,
    buyPct: asUnitInterval(raw?.buyPct) ?? fallback.buyPct,
  };
}

export function mergeStrategyConfig(raw: unknown): StrategyConfigFile {
  const input = raw && typeof raw === "object" ? (raw as Partial<StrategyConfigFile>) : {};
  return {
    Level1_Stable: mergeLevel1(input.Level1_Stable, DEFAULT_STRATEGY_CONFIG.Level1_Stable),
    Level5_Swing: mergeLevel5(input.Level5_Swing, DEFAULT_STRATEGY_CONFIG.Level5_Swing),
    Level10_Aggressive: mergeLevel10(
      input.Level10_Aggressive,
      DEFAULT_STRATEGY_CONFIG.Level10_Aggressive,
    ),
  };
}

export function validateStrategyConfig(config: StrategyConfigFile): string | null {
  const l1 = config.Level1_Stable;
  if (l1.intervalMs < 1_000) return "Level1 매수 주기는 1초 이상이어야 합니다.";
  if (l1.slicePct <= 0 || l1.slicePct > 1) return "Level1 버킷 비율은 0과 1 사이여야 합니다.";
  const l5 = config.Level5_Swing;
  if (l5.fastMa >= l5.slowMa) return "Level5 단기 이평은 장기 이평보다 짧아야 합니다.";
  const l10 = config.Level10_Aggressive;
  if (l10.universe.length < 1) return "Level10 유니버스에 종목이 필요합니다.";
  if (l10.cooldownMs < 0) return "Level10 쿨다운이 음수입니다.";
  if (l10.k <= 0 || l10.k > 2) return "Level10 K값은 0 초과 2 이하여야 합니다.";
  return null;
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
  if (!inTest()) {
    mkdirSync(path.dirname(STRATEGY_CONFIG_PATH), { recursive: true });
    writeFileSync(STRATEGY_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } else {
    testOverride = cloneConfig(next);
  }
  cache = { mtimeMs: fileMtimeMs() || Date.now(), value: next };
  return cloneConfig(next);
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
