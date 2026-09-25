export type TradingMode = "paper" | "live_test" | "live";

export type EnvMap = Record<string, string | undefined>;

/**
 * Resolve TRADING_MODE. Default is live_test (KIS PAPER operational).
 * Legacy "mock" / "MOCK" values are rejected — fail closed to live_test with no mock book.
 */
export function tradingMode(env: EnvMap = process.env): TradingMode {
  const raw = String(env.TRADING_MODE ?? "live_test")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  if (raw === "live_test") return "live_test";
  if (raw === "live") return "live";
  if (raw === "paper") return "paper";
  // Legacy MOCK removed: treat as live_test so product never runs a mock book.
  if (raw === "mock" || raw === "") return "live_test";
  return "live_test";
}

export function allowLiveTrading(env: EnvMap = process.env): boolean {
  return env.ALLOW_LIVE_TRADING === "true";
}

export function isLiveLike(mode: TradingMode = tradingMode()): boolean {
  return mode === "live_test" || mode === "live";
}

/** Browser /api/tick is never allowed for live_test/live (worker+lock only). */
export function httpTickAllowed(mode: TradingMode = tradingMode()): boolean {
  return mode === "paper";
}

export function liveOrdersLocked(env: EnvMap = process.env): string | null {
  if (tradingMode(env) !== "live") return null;
  if (allowLiveTrading(env)) return null;
  return "실전 주문이 잠겨 있습니다. ALLOW_LIVE_TRADING=true 가 필요합니다.";
}

/** Real-host KIS orders require TRADING_MODE=live and ALLOW_LIVE_TRADING=true. */
export function realKisOrdersLocked(env: EnvMap = process.env): string | null {
  if (tradingMode(env) === "live" && allowLiveTrading(env)) return null;
  return "실전 KIS 주문은 TRADING_MODE=live 와 ALLOW_LIVE_TRADING=true 가 필요합니다. 모의투자는 KIS_MODE=paper 와 KIS_PAPER_* 를 사용하세요.";
}

export type LiveTestCaps = {
  maxOrderKrw: number;
  maxDailyBuyKrw: number;
  maxDailyOrders: number;
  maxPositionKrw: number;
  maxPositionCount: number;
};

export const DEFAULT_LIVE_TEST_CAPS: LiveTestCaps = {
  maxOrderKrw: 10_000,
  maxDailyBuyKrw: 30_000,
  maxDailyOrders: 3,
  maxPositionKrw: 30_000,
  maxPositionCount: 2,
};

/** Env may only tighten LIVE_TEST caps. Values above the default are ignored. */
function envIntCap(env: EnvMap, key: string, ceiling: number): number {
  const n = Number(env[key]);
  if (!Number.isFinite(n) || n <= 0) return ceiling;
  return Math.min(ceiling, Math.floor(n));
}

export function liveTestCaps(env: EnvMap = process.env): LiveTestCaps {
  return {
    maxOrderKrw: envIntCap(env, "LIVE_TEST_MAX_ORDER_KRW", DEFAULT_LIVE_TEST_CAPS.maxOrderKrw),
    maxDailyBuyKrw: envIntCap(env, "LIVE_TEST_MAX_DAILY_ORDER_AMOUNT", DEFAULT_LIVE_TEST_CAPS.maxDailyBuyKrw),
    maxDailyOrders: envIntCap(env, "LIVE_TEST_MAX_DAILY_ORDER_COUNT", DEFAULT_LIVE_TEST_CAPS.maxDailyOrders),
    maxPositionKrw: envIntCap(env, "LIVE_TEST_MAX_POSITION_AMOUNT", DEFAULT_LIVE_TEST_CAPS.maxPositionKrw),
    maxPositionCount: envIntCap(env, "LIVE_TEST_MAX_POSITION_COUNT", DEFAULT_LIVE_TEST_CAPS.maxPositionCount),
  };
}
