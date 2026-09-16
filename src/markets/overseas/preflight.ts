import { loadKisConfig, resolveKisEnvironment, type EnvMap as KisEnv } from "@/src/brokers/kis-config";
import { overseasPaperOrdersLocked, vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { krwEquivalent } from "@/src/markets/overseas/fx";
import type { OverseasMarketStatus } from "@/src/markets/overseas/types";
import { DEFAULT_LIVE_TEST_CAPS, liveTestCaps, tradingMode, type EnvMap } from "@/src/runtime/trading-mode";

export const OVERSEAS_ORDER_TEST_BLOCKED = "ORDER TEST BLOCKED";

export type OverseasPreflightCheck = "PASS" | "FAIL";

export type OverseasVtsBPreflightInput = {
  env?: EnvMap & KisEnv;
  quoteHealthy: boolean;
  foreignBalanceHealthy: boolean;
  reconciliationHealthy: boolean;
  marketStatus: OverseasMarketStatus;
  riskHealthy: boolean;
  usdCash: number | null;
  usdOrderable: number | null;
  nativePrice?: number | null;
  qty?: number;
  fxRate?: number | null;
  symbol?: string;
};

export type OverseasVtsBPreflightResult = {
  ok: boolean;
  blocked: string | null;
  checks: {
    environment: OverseasPreflightCheck;
    optIn: OverseasPreflightCheck;
    realDisabled: OverseasPreflightCheck;
    reconciliation: OverseasPreflightCheck;
    quote: OverseasPreflightCheck;
    foreignBalance: OverseasPreflightCheck;
    market: OverseasPreflightCheck;
    risk: OverseasPreflightCheck;
    orderableUsd: OverseasPreflightCheck;
  };
  usdCash: number | null;
  usdOrderable: number | null;
  instrumentEligible: boolean | null;
  instrumentBlock: string | null;
};

function flag(ok: boolean): OverseasPreflightCheck {
  return ok ? "PASS" : "FAIL";
}

/** LIVE_TEST 1주 상한. Does not raise the KRW cap. Missing FX is not invented. */
export function overseasMaxUsdPricePerShare(
  fxRate: number | null | undefined,
  maxOrderKrw: number = DEFAULT_LIVE_TEST_CAPS.maxOrderKrw,
): number | null {
  if (fxRate == null || !Number.isFinite(fxRate) || fxRate <= 0) return null;
  if (!Number.isFinite(maxOrderKrw) || maxOrderKrw <= 0) return null;
  return maxOrderKrw / fxRate;
}

export function overseasUsdOrderableOk(orderable: number | null | undefined): boolean {
  return orderable != null && Number.isFinite(orderable) && orderable > 0;
}

export function overseasBuyCashGate(orderableUsd: number | null | undefined): {
  ok: boolean;
  blocked: string | null;
} {
  if (!overseasUsdOrderableOk(orderableUsd)) {
    return {
      ok: false,
      blocked: `${OVERSEAS_ORDER_TEST_BLOCKED}: USD orderable amount is 0`,
    };
  }
  return { ok: true, blocked: null };
}

export function overseasOneShareEligibility(input: {
  symbol?: string;
  nativePrice: number;
  usdOrderable: number | null | undefined;
  fxRate?: number | null;
  qty?: number;
  env?: EnvMap;
}): { eligible: boolean; reason: string; krwNotional: number | null; riskLimitKrw: number } {
  const qty = input.qty && input.qty > 0 ? input.qty : 1;
  const caps = liveTestCaps(input.env);
  const nativeValue = Math.max(0, input.nativePrice) * qty;
  const krwNotional = krwEquivalent(nativeValue, input.fxRate);
  if (!overseasUsdOrderableOk(input.usdOrderable)) {
    return {
      eligible: false,
      reason: `${OVERSEAS_ORDER_TEST_BLOCKED}: USD orderable amount is 0`,
      krwNotional,
      riskLimitKrw: caps.maxOrderKrw,
    };
  }
  if (nativeValue > (input.usdOrderable ?? 0) + 1e-8) {
    return {
      eligible: false,
      reason: `${OVERSEAS_ORDER_TEST_BLOCKED}: USD orderable amount cannot buy ${qty} share`,
      krwNotional,
      riskLimitKrw: caps.maxOrderKrw,
    };
  }
  if (krwNotional != null && krwNotional > caps.maxOrderKrw) {
    return {
      eligible: false,
      reason: `${OVERSEAS_ORDER_TEST_BLOCKED}: Instrument exceeds VTS overseas risk limit`,
      krwNotional,
      riskLimitKrw: caps.maxOrderKrw,
    };
  }
  return { eligible: true, reason: "", krwNotional, riskLimitKrw: caps.maxOrderKrw };
}

export function overseasVtsBEnvironment(env: EnvMap & KisEnv = process.env): {
  environment: boolean;
  optIn: boolean;
  realDisabled: boolean;
  blocked: string | null;
} {
  const locked = overseasPaperOrdersLocked(env);
  const realDisabled = locked == null || !/REAL/.test(locked);
  const optIn = vtsOverseasOrderTestsEnabled(env);
  let environment = true;
  let blocked: string | null = null;
  if (env.BROKER !== "kis") {
    environment = false;
    blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: BROKER must be kis`;
  }
  if (tradingMode(env) !== "live_test") {
    environment = false;
    blocked = blocked ?? `${OVERSEAS_ORDER_TEST_BLOCKED}: TRADING_MODE must be live_test`;
  }
  try {
    if (resolveKisEnvironment(env) !== "paper") {
      environment = false;
      blocked = blocked ?? `${OVERSEAS_ORDER_TEST_BLOCKED}: KIS_MODE must be paper (or demo)`;
    }
  } catch {
    environment = false;
    blocked = blocked ?? `${OVERSEAS_ORDER_TEST_BLOCKED}: KIS_MODE must be paper (or demo)`;
  }
  const kis = loadKisConfig(env);
  if (kis.environment !== "paper" || kis.host.includes("openapi.koreainvestment.com:9443")) {
    environment = false;
    blocked = blocked ?? `${OVERSEAS_ORDER_TEST_BLOCKED}: KIS host is not VTS paper`;
  }
  if (!realDisabled) {
    blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: REAL trading configuration detected.`;
  }
  if (environment && realDisabled && !optIn) {
    blocked = locked ?? `${OVERSEAS_ORDER_TEST_BLOCKED}: RUN_KIS_VTS_OVERSEAS_ORDER_TESTS is not true`;
  }
  return { environment, optIn, realDisabled, blocked };
}

export function overseasVtsBPreflight(
  input: OverseasVtsBPreflightInput,
): OverseasVtsBPreflightResult {
  const env = input.env ?? process.env;
  const envCheck = overseasVtsBEnvironment(env);
  const orderableOk = overseasUsdOrderableOk(input.usdOrderable);
  const marketOk = input.marketStatus === "open";
  const caps = liveTestCaps(env);
  const capOk = caps.maxOrderKrw <= DEFAULT_LIVE_TEST_CAPS.maxOrderKrw;
  const qty = input.qty && input.qty > 0 ? input.qty : 1;
  const krwNotional =
    input.nativePrice != null && input.nativePrice > 0
      ? krwEquivalent(input.nativePrice * qty, input.fxRate)
      : null;
  const exceedsRiskLimit = krwNotional != null && krwNotional > caps.maxOrderKrw;
  const instrument =
    input.nativePrice != null && input.nativePrice > 0
      ? overseasOneShareEligibility({
          symbol: input.symbol,
          nativePrice: input.nativePrice,
          usdOrderable: input.usdOrderable,
          fxRate: input.fxRate,
          qty,
          env,
        })
      : null;
  const checks = {
    environment: flag(envCheck.environment),
    optIn: flag(envCheck.optIn),
    realDisabled: flag(envCheck.realDisabled),
    reconciliation: flag(input.reconciliationHealthy),
    quote: flag(input.quoteHealthy),
    foreignBalance: flag(input.foreignBalanceHealthy),
    market: flag(marketOk),
    risk: flag(input.riskHealthy && capOk && !exceedsRiskLimit),
    orderableUsd: flag(orderableOk),
  };

  let blocked: string | null = null;
  if (!envCheck.realDisabled) blocked = envCheck.blocked;
  else if (!envCheck.environment) blocked = envCheck.blocked;
  else if (!envCheck.optIn) blocked = envCheck.blocked;
  else if (!input.reconciliationHealthy) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: overseas reconciliation unhealthy`;
  else if (!input.quoteHealthy) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: quote unhealthy`;
  else if (!input.foreignBalanceHealthy) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: foreign balance unhealthy`;
  else if (!orderableOk) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: USD orderable amount is 0`;
  else if (!marketOk) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: US market is not open`;
  else if (!input.riskHealthy || !capOk) blocked = `${OVERSEAS_ORDER_TEST_BLOCKED}: risk unhealthy`;
  else if (instrument && !instrument.eligible) blocked = instrument.reason;

  return {
    ok: blocked == null,
    blocked,
    checks,
    usdCash: input.usdCash,
    usdOrderable: input.usdOrderable,
    instrumentEligible: instrument ? instrument.eligible : null,
    instrumentBlock: instrument && !instrument.eligible ? instrument.reason : null,
  };
}
