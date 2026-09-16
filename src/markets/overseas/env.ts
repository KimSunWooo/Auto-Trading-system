import { tradingMode, type EnvMap } from "@/src/runtime/trading-mode";

export const VTS_OVERSEAS_TESTS_ENV = "RUN_KIS_VTS_OVERSEAS_TESTS";
export const VTS_OVERSEAS_ORDER_TESTS_ENV = "RUN_KIS_VTS_OVERSEAS_ORDER_TESTS";
export const VTS_OVERSEAS_TEST_SYMBOL_ENV = "VTS_OVERSEAS_TEST_SYMBOL";
export const VTS_OVERSEAS_TEST_EXCHANGE_ENV = "VTS_OVERSEAS_TEST_EXCHANGE";

function overseasRealFlags(env: EnvMap): string[] {
  const flags: string[] = [];
  if (String(env.KIS_MODE ?? "").trim().toLowerCase() === "real") flags.push("KIS_MODE");
  if (tradingMode(env) === "live") flags.push("TRADING_MODE");
  if (env.ALLOW_LIVE_TRADING === "true") flags.push("ALLOW_LIVE_TRADING");
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") flags.push("KIS_LIVE_CONFIRM");
  return flags;
}

export function vtsOverseasReadTestsEnabled(env: EnvMap = process.env): boolean {
  return env[VTS_OVERSEAS_TESTS_ENV] === "true";
}

export function vtsOverseasOrderTestsEnabled(env: EnvMap = process.env): boolean {
  return env[VTS_OVERSEAS_ORDER_TESTS_ENV] === "true";
}

/** Overseas PAPER orders stay locked until a dedicated opt-in is set. Independent of domestic VTS-B. */
export function overseasPaperOrdersLocked(env: EnvMap = process.env): string | null {
  const real = overseasRealFlags(env);
  if (real.length) {
    return "REAL trading configuration detected. 해외 주문을 내지 않습니다.";
  }
  if (!vtsOverseasOrderTestsEnabled(env)) {
    return `${VTS_OVERSEAS_ORDER_TESTS_ENV} 가 없어 해외 PAPER 주문을 내지 않습니다.`;
  }
  return null;
}
