import type { AppState, Order } from "@/lib/types";
import { loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { tradingMode, type EnvMap } from "@/src/runtime/trading-mode";

/** VTS / dedicated order-test harness only. Not used for operational PAPER soak. */
export const PAPER_TEST_POLICY = {
  id: "PAPER_TEST_POLICY" as const,
  maxQtyPerOrder: 1,
  maxNewBuyPerTestRun: 1,
  maxSameIntentSubmit: 1,
  maxSameSymbolOpenBuy: 1,
  maxPaperTestOrdersPerDay: 5,
  maxBrokerSubmitsPerDay: 5,
  maxPositionQtyPerSymbol: 1,
  enforceAmountCaps: false,
} as const;

/** Operational PAPER defaults. Overridable via env. Never shared with REAL. */
export const PAPER_OPERATION_DEFAULTS = {
  id: "PAPER_OPERATION_POLICY" as const,
  maxQtyPerOrder: 11,
  maxBrokerSubmitsPerDay: 20,
  maxPositionQtyPerSymbol: 50,
  maxSameIntentSubmit: 1,
  maxSameSymbolOpenBuy: 1,
  enforceAmountCaps: false,
} as const;

/** REAL: keep amount + count + exposure. Never relaxed by PAPER policy. */
export const REAL_ORDER_POLICY = {
  id: "REAL_ORDER_POLICY" as const,
  enforceAmountCaps: true,
} as const;

export type PaperOperationPolicy = {
  id: typeof PAPER_OPERATION_DEFAULTS.id;
  maxQtyPerOrder: number;
  maxBrokerSubmitsPerDay: number;
  maxPositionQtyPerSymbol: number;
  maxSameIntentSubmit: number;
  maxSameSymbolOpenBuy: number;
  enforceAmountCaps: false;
};

/**
 * Backward-compatible alias for operational PAPER (not the old 1-share test caps).
 * Prefer paperOperationPolicy(env) when env-aware values are needed.
 */
export const PAPER_ORDER_POLICY = {
  id: PAPER_OPERATION_DEFAULTS.id,
  maxQtyPerOrder: PAPER_OPERATION_DEFAULTS.maxQtyPerOrder,
  maxSameIntentSubmit: PAPER_OPERATION_DEFAULTS.maxSameIntentSubmit,
  maxSameSymbolOpenBuy: PAPER_OPERATION_DEFAULTS.maxSameSymbolOpenBuy,
  maxBrokerSubmitsPerDay: PAPER_OPERATION_DEFAULTS.maxBrokerSubmitsPerDay,
  maxPositionQtyPerSymbol: PAPER_OPERATION_DEFAULTS.maxPositionQtyPerSymbol,
  enforceAmountCaps: false as const,
  /** @deprecated operational PAPER no longer uses testRun buy caps */
  maxNewBuyPerTestRun: Number.POSITIVE_INFINITY,
  /** @deprecated use maxBrokerSubmitsPerDay */
  maxPaperTestOrdersPerDay: PAPER_OPERATION_DEFAULTS.maxBrokerSubmitsPerDay,
};

export type OrderPolicy = PaperOperationPolicy | typeof REAL_ORDER_POLICY | typeof PAPER_TEST_POLICY;

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
 * Positive integer env. Empty → fallback. 0 / negative / NaN / Infinity → rejected (fallback).
 */
export function parsePositiveIntEnv(
  raw: string | undefined | null,
  fallback: number,
): { value: number; rejected: boolean } {
  if (raw == null || String(raw).trim() === "") return { value: fallback, rejected: false };
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { value: fallback, rejected: true };
  }
  return { value: n, rejected: false };
}

/** VTS dedicated order tests keep the historical 1-share / 1-buy harness. */
export function isPaperTestHarness(env: EnvMap = process.env): boolean {
  return (
    env.RUN_KIS_VTS_ORDER_TESTS === "true" ||
    env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS === "true" ||
    env.PAPER_POLICY_MODE === "test"
  );
}

export function paperOperationPolicy(env: EnvMap = process.env): PaperOperationPolicy {
  const qty = parsePositiveIntEnv(env.PAPER_MAX_QTY_PER_ORDER, PAPER_OPERATION_DEFAULTS.maxQtyPerOrder);
  const daily = parsePositiveIntEnv(
    env.PAPER_MAX_BROKER_SUBMITS_PER_DAY,
    PAPER_OPERATION_DEFAULTS.maxBrokerSubmitsPerDay,
  );
  const pos = parsePositiveIntEnv(
    env.PAPER_MAX_POSITION_QTY_PER_SYMBOL,
    PAPER_OPERATION_DEFAULTS.maxPositionQtyPerSymbol,
  );
  return {
    id: PAPER_OPERATION_DEFAULTS.id,
    maxQtyPerOrder: qty.value,
    maxBrokerSubmitsPerDay: daily.value,
    maxPositionQtyPerSymbol: pos.value,
    maxSameIntentSubmit: PAPER_OPERATION_DEFAULTS.maxSameIntentSubmit,
    maxSameSymbolOpenBuy: PAPER_OPERATION_DEFAULTS.maxSameSymbolOpenBuy,
    enforceAmountCaps: false,
  };
}

/**
 * Active PAPER policy: harness → PAPER_TEST_POLICY, else operational env-aware policy.
 * REAL / mixed flags never return PAPER.
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
  if (!usesPaperOrderPolicy(env)) return REAL_ORDER_POLICY;
  if (isPaperTestHarness(env)) return PAPER_TEST_POLICY;
  return paperOperationPolicy(env);
}

/** Operational daily broker-submit cap (Seoul day). Test harness uses PAPER_TEST_POLICY. */
export function paperMaxBrokerSubmitsPerDay(env: EnvMap = process.env): number {
  const policy = activeOrderPolicy(env);
  if (policy.id === "REAL_ORDER_POLICY") return Number.POSITIVE_INFINITY;
  if (policy.id === "PAPER_TEST_POLICY") return PAPER_TEST_POLICY.maxBrokerSubmitsPerDay;
  return (policy as PaperOperationPolicy).maxBrokerSubmitsPerDay;
}

export function paperMaxQtyPerOrder(env: EnvMap = process.env): number {
  const policy = activeOrderPolicy(env);
  if (policy.id === "REAL_ORDER_POLICY") return Number.POSITIVE_INFINITY;
  if (policy.id === "PAPER_TEST_POLICY") return PAPER_TEST_POLICY.maxQtyPerOrder;
  return (policy as PaperOperationPolicy).maxQtyPerOrder;
}

export function paperMaxPositionQtyPerSymbol(env: EnvMap = process.env): number {
  const policy = activeOrderPolicy(env);
  if (policy.id === "REAL_ORDER_POLICY") return Number.POSITIVE_INFINITY;
  if (policy.id === "PAPER_TEST_POLICY") return PAPER_TEST_POLICY.maxPositionQtyPerSymbol;
  return (policy as PaperOperationPolicy).maxPositionQtyPerSymbol;
}

/** @deprecated Prefer paperMaxBrokerSubmitsPerDay(env). Kept for soak report imports. */
export const CONTROLLED_RUN_MAX_BROKER_SUBMITS = PAPER_OPERATION_DEFAULTS.maxBrokerSubmitsPerDay;

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

export function sessionOrders(state: AppState, startedAt?: string): Order[] {
  const start = startedAt ?? state.controlledRun?.startedAt;
  if (!start) return state.orders.filter((order) => countsTowardPaperDay(order));
  const startMs = Date.parse(start);
  return state.orders.filter((order) => {
    if (!countsTowardPaperDay(order)) return false;
    return Date.parse(order.createdAt) >= startMs;
  });
}

export function sessionBrokerSubmitCount(state: AppState): number {
  return sessionOrders(state, state.controlledRun?.startedAt).length;
}

export function dailyBrokerSubmitCount(state: AppState, day = seoulDay()): number {
  return state.orders.filter(
    (order) => countsTowardPaperDay(order) && seoulDay(new Date(order.createdAt)) === day,
  ).length;
}

export function hasUnknownOrder(state: AppState): boolean {
  return state.orders.some((order) => !order.parentOrderId && order.status === "unknown");
}

export function heldQtyForSymbol(state: AppState, ticker: string): number {
  const code = ticker.includes(":") ? ticker : ticker.replace(/\D/g, "").slice(-6).padStart(6, "0");
  return state.positions
    .filter((row) => {
      const rowCode = row.code.includes(":")
        ? row.code
        : row.code.replace(/\D/g, "").slice(-6).padStart(6, "0");
      return rowCode === code || row.code === ticker;
    })
    .reduce((sum, row) => sum + row.qty, 0);
}

/**
 * Operational PAPER constraints (qty ≤ max, daily submit, position qty).
 * Test harness additionally enforces maxNewBuyPerTestRun and exact 1-share history.
 */
export function checkPaperOrderConstraints(
  input: {
    qty: number;
    ticker?: string;
    state?: AppState;
    side?: "buy" | "sell";
  },
  env: EnvMap = process.env,
): { ok: boolean; blocked: string | null } {
  if (!Number.isInteger(input.qty) || input.qty < 1) {
    return { ok: false, blocked: "ORDER TEST BLOCKED: PAPER qty must be a positive integer" };
  }

  const qtyParsed = parsePositiveIntEnv(
    env.PAPER_MAX_QTY_PER_ORDER,
    PAPER_OPERATION_DEFAULTS.maxQtyPerOrder,
  );
  if (qtyParsed.rejected && !isPaperTestHarness(env)) {
    return {
      ok: false,
      blocked: "ORDER TEST BLOCKED: invalid PAPER_MAX_QTY_PER_ORDER",
    };
  }

  const maxQty = paperMaxQtyPerOrder(env);
  if (input.qty > maxQty) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: PAPER qty must be <= ${maxQty}`,
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

  const side = input.side ?? "buy";
  if (side === "buy" && input.ticker) {
    const held = heldQtyForSymbol(state, input.ticker);
    const maxPos = paperMaxPositionQtyPerSymbol(env);
    if (held + input.qty > maxPos) {
      return {
        ok: false,
        blocked: `ORDER TEST BLOCKED: PAPER position qty cap ${maxPos} for ${input.ticker}`,
      };
    }
  }

  if (isPaperTestHarness(env)) {
    const buyIntents = (state.intents ?? []).filter((row) => {
      if (row.side !== "buy" || row.status === "rejected") return false;
      const since = state.controlledRun?.startedAt;
      if (!since) return true;
      return Date.parse(row.createdAt) >= Date.parse(since);
    }).length;
    if (
      Math.max(testRunBuyCount(state, state.controlledRun?.startedAt), buyIntents) >=
      PAPER_TEST_POLICY.maxNewBuyPerTestRun
    ) {
      return {
        ok: false,
        blocked: `ORDER TEST BLOCKED: maxNewBuyPerTestRun ${PAPER_TEST_POLICY.maxNewBuyPerTestRun}`,
      };
    }
  }

  const dailyCap = paperMaxBrokerSubmitsPerDay(env);
  const todays = dailyBrokerSubmitCount(state);
  if (todays >= dailyCap) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: PAPER daily order cap ${dailyCap}`,
    };
  }
  return { ok: true, blocked: null };
}
