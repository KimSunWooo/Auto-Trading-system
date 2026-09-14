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
