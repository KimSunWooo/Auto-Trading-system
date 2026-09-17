import type { AppState, Order } from "@/lib/types";
import { loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { tradingMode, type EnvMap } from "@/src/runtime/trading-mode";

/** PAPER/VTS: qty and count, not ticket amount. Never selected for REAL. */
export const PAPER_ORDER_POLICY = {
  id: "PAPER_ORDER_POLICY" as const,
  maxQtyPerOrder: 1,
  maxNewBuyPerTestRun: 1,
  maxSameIntentSubmit: 1,
  maxSameSymbolOpenBuy: 1,
  maxPaperTestOrdersPerDay: 5,
  enforceAmountCaps: false,
};

/** REAL: keep amount + count + exposure. Never relaxed by PAPER policy. */
export const REAL_ORDER_POLICY = {
  id: "REAL_ORDER_POLICY" as const,
  enforceAmountCaps: true,
};

export type OrderPolicy = typeof PAPER_ORDER_POLICY | typeof REAL_ORDER_POLICY;

function seoulDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

function explicitPaperKisMode(env: EnvMap): boolean {
  const raw = String(env.KIS_MODE ?? "").trim().toLowerCase();
  return raw === "paper" || raw === "demo";
}

function realPolicyFlags(env: EnvMap): string[] {
  const flags: string[] = [];
  if (String(env.KIS_MODE ?? "").trim().toLowerCase() === "real") flags.push("KIS_MODE");
  if (tradingMode(env) === "live") flags.push("TRADING_MODE");
  if (env.ALLOW_LIVE_TRADING === "true") flags.push("ALLOW_LIVE_TRADING");
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") flags.push("KIS_LIVE_CONFIRM");
  return flags;
}

/**
 * PAPER_ORDER_POLICY only when LIVE_TEST + explicit KIS paper/demo + BROKER=kis
 * and no REAL flags. Empty KIS_MODE does not select PAPER (LIVE_TEST 10,000원 유지).
 * REAL or mixed REAL flags always get REAL_ORDER_POLICY.
 */
export function usesPaperOrderPolicy(env: EnvMap = process.env): boolean {
  if (realPolicyFlags(env).length) return false;
  if (tradingMode(env) !== "live_test") return false;
  if (env.BROKER !== "kis") return false;
  if (!explicitPaperKisMode(env)) return false;
  try {
    if (resolveKisEnvironment(env) !== "paper") return false;
  } catch {
    return false;
  }
  const kis = loadKisConfig(env);
  if (kis.environment !== "paper") return false;
  if (kis.host.includes("openapi.koreainvestment.com:9443")) return false;
  return true;
}

export function activeOrderPolicy(env: EnvMap = process.env): OrderPolicy {
  return usesPaperOrderPolicy(env) ? PAPER_ORDER_POLICY : REAL_ORDER_POLICY;
}

function countsTowardPaperDay(order: Order): boolean {
  if (order.parentOrderId) return false;
  return order.status === "filled" || order.status === "pending" || order.status === "unknown";
}

export function existingOpenBuy(state: AppState, ticker: string): Order | undefined {
  return state.orders.find(
    (order) =>
      !order.parentOrderId &&
      order.side === "buy" &&
      order.code === ticker &&
      (order.status === "pending" || order.status === "unknown"),
  );
}

export function testRunBuyCount(state: AppState, sinceIso?: string): number {
  const startMs = sinceIso ? Date.parse(sinceIso) : NaN;
  return state.orders.filter((order) => {
    if (order.parentOrderId || order.side !== "buy" || !countsTowardPaperDay(order)) return false;
    if (Number.isFinite(startMs) && Date.parse(order.createdAt) < startMs) return false;
    return true;
  }).length;
}

export function hasUnknownOrder(state: AppState): boolean {
  return state.orders.some((order) => !order.parentOrderId && order.status === "unknown");
}

export function checkPaperOrderConstraints(input: {
  qty: number;
  ticker?: string;
  state?: AppState;
}): { ok: boolean; blocked: string | null } {
  if (input.qty !== PAPER_ORDER_POLICY.maxQtyPerOrder) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: PAPER qty must be ${PAPER_ORDER_POLICY.maxQtyPerOrder}`,
    };
  }
  const state = input.state;
  if (!state) return { ok: true, blocked: null };
  if (hasUnknownOrder(state)) {
    return { ok: false, blocked: "ORDER TEST BLOCKED: UNKNOWN order present" };
  }
  if (input.ticker && existingOpenBuy(state, input.ticker)) {
    return { ok: false, blocked: "ORDER TEST BLOCKED: Existing open BUY order detected" };
  }
  const buyIntents = (state.intents ?? []).filter((row) => {
    if (row.side !== "buy" || row.status === "rejected") return false;
    const since = state.controlledRun?.startedAt;
    if (!since) return true;
    return Date.parse(row.createdAt) >= Date.parse(since);
  }).length;
  if (Math.max(testRunBuyCount(state, state.controlledRun?.startedAt), buyIntents) >= PAPER_ORDER_POLICY.maxNewBuyPerTestRun) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: maxNewBuyPerTestRun ${PAPER_ORDER_POLICY.maxNewBuyPerTestRun}`,
    };
  }
  const today = seoulDay();
  const todays = state.orders.filter(
    (order) => countsTowardPaperDay(order) && seoulDay(new Date(order.createdAt)) === today,
  );
  if (todays.length >= PAPER_ORDER_POLICY.maxPaperTestOrdersPerDay) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: PAPER daily order cap ${PAPER_ORDER_POLICY.maxPaperTestOrdersPerDay}`,
    };
  }
  return { ok: true, blocked: null };
}
