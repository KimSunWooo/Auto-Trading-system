export type TradingMode = "mock" | "paper" | "live_test" | "live";

export type MockBrokerMode =
  | "instant"
  | "delayed"
  | "reject"
  | "timeout"
  | "unknown"
  | "partial";

export type EnvMap = Record<string, string | undefined>;

export function tradingMode(env: EnvMap = process.env): TradingMode {
  const raw = String(env.TRADING_MODE ?? "mock")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  if (raw === "live_test") return "live_test";
  if (raw === "live") return "live";
  if (raw === "paper") return "paper";
  return "mock";
}

export function allowLiveTrading(env: EnvMap = process.env): boolean {
  return env.ALLOW_LIVE_TRADING === "true";
}

export function isLiveLike(mode: TradingMode = tradingMode()): boolean {
  return mode === "live_test" || mode === "live";
}

export function httpTickAllowed(mode: TradingMode = tradingMode()): boolean {
  return mode === "mock" || mode === "paper";
}

export function liveOrdersLocked(env: EnvMap = process.env): string | null {
  if (tradingMode(env) !== "live") return null;
  if (allowLiveTrading(env)) return null;
  return "실전 주문이 잠겨 있습니다. ALLOW_LIVE_TRADING=true 가 필요합니다.";
}

/** Real-host KIS orders require TRADING_MODE=live and ALLOW_LIVE_TRADING=true. */
export function realKisOrdersLocked(env: EnvMap = process.env): string | null {
  if (tradingMode(env) === "live" && allowLiveTrading(env)) return null;
  return "실전 KIS 주문은 TRADING_MODE=live 와 ALLOW_LIVE_TRADING=true 가 필요합니다. 모의투자는 KIS_MODE=demo 를 사용하세요.";
}

export function mockBrokerMode(env: EnvMap = process.env): MockBrokerMode {
  const raw = String(env.MOCK_BROKER_MODE ?? "instant").trim().toLowerCase();
  if (
    raw === "delayed" ||
    raw === "reject" ||
    raw === "timeout" ||
    raw === "unknown" ||
    raw === "partial"
  ) {
    return raw;
  }
  return "instant";
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
