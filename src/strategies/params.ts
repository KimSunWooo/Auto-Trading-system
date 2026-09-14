export type Level1Params = {
  ticker: string;
  intervalMs: number;
  sliceKrw: number;
  slicePct: number;
  minAmountKrw: number;
};

export type Level5Params = {
  ticker: string;
  fastMa: number;
  slowMa: number;
  buyPct: number;
};

export type Level10Params = {
  universe: string[];
  cooldownMs: number;
  k: number;
  minDayReturn: number;
  buyPct: number;
};

export type StrategyConfigFile = {
  Level1_Stable: Level1Params;
  Level5_Swing: Level5Params;
  Level10_Aggressive: Level10Params;
};

export type StrategyConfigGetResponse = {
  config: StrategyConfigFile;
  defaults: StrategyConfigFile;
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfigFile = {
  Level1_Stable: {
    ticker: "069500",
    intervalMs: 45_000,
    sliceKrw: 150_000,
    slicePct: 0.05,
    minAmountKrw: 10_000,
  },
  Level5_Swing: {
    ticker: "005930",
    fastMa: 5,
    slowMa: 20,
    buyPct: 0.35,
  },
  Level10_Aggressive: {
    universe: ["005930", "000660", "035720", "247540", "259960", "352820"],
    cooldownMs: 120_000,
    k: 0.4,
    minDayReturn: 0.004,
    buyPct: 0.25,
  },
};

export const KODEX_200 = DEFAULT_STRATEGY_CONFIG.Level1_Stable.ticker;
export const SWING_TICKER = DEFAULT_STRATEGY_CONFIG.Level5_Swing.ticker;
export const AGGRESSIVE_UNIVERSE = DEFAULT_STRATEGY_CONFIG.Level10_Aggressive.universe;

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asPositive(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n > 0 ? n : undefined;
}

export function asUnitInterval(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n >= 0 && n <= 1 ? n : undefined;
}

export function normalizeTicker(value: unknown): string | undefined {
  const digits = String(value ?? "").replace(/\D/g, "").slice(-6).padStart(6, "0");
  if (!/^\d{6}$/.test(digits) || digits === "000000") return undefined;
  return digits;
}

export function asUniverse(value: unknown): string[] | undefined {
  let raw: string[] = [];
  if (Array.isArray(value)) raw = value.map((row) => String(row));
  else if (typeof value === "string") raw = value.split(/[,\s]+/);
  const tickers = [...new Set(raw.map((row) => normalizeTicker(row)).filter((row): row is string => Boolean(row)))];
  return tickers.length > 0 ? tickers : undefined;
}

export function mergeLevel1(raw: Partial<Level1Params> | undefined, fallback: Level1Params): Level1Params {
  return {
    ticker: normalizeTicker(raw?.ticker) ?? fallback.ticker,
    intervalMs: Math.round(asPositive(raw?.intervalMs) ?? fallback.intervalMs),
    sliceKrw: Math.round(asPositive(raw?.sliceKrw) ?? fallback.sliceKrw),
    slicePct: asUnitInterval(raw?.slicePct) ?? fallback.slicePct,
    minAmountKrw: Math.round(asPositive(raw?.minAmountKrw) ?? fallback.minAmountKrw),
  };
}

export function mergeLevel5(raw: Partial<Level5Params> | undefined, fallback: Level5Params): Level5Params {
  const fastMa = Math.round(asPositive(raw?.fastMa) ?? fallback.fastMa);
  const slowMa = Math.round(asPositive(raw?.slowMa) ?? fallback.slowMa);
  return {
    ticker: normalizeTicker(raw?.ticker) ?? fallback.ticker,
    fastMa,
    slowMa,
    buyPct: asUnitInterval(raw?.buyPct) ?? fallback.buyPct,
  };
}

export function mergeLevel10(
  raw:
    | {
        universe?: unknown;
        cooldownMs?: unknown;
        k?: unknown;
        minDayReturn?: unknown;
        buyPct?: unknown;
      }
    | undefined,
  fallback: Level10Params,
): Level10Params {
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

export function overlayStrategyConfig(base: StrategyConfigFile, raw: unknown): StrategyConfigFile {
  const input = raw && typeof raw === "object" ? (raw as Partial<StrategyConfigFile>) : {};
  return {
    Level1_Stable: mergeLevel1(input.Level1_Stable, base.Level1_Stable),
    Level5_Swing: mergeLevel5(input.Level5_Swing, base.Level5_Swing),
    Level10_Aggressive: mergeLevel10(input.Level10_Aggressive, base.Level10_Aggressive),
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
