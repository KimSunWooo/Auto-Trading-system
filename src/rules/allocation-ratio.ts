/**
 * Shared strategy cash allocation math.
 * Ratio base = latest PAPER orderable cash (ord_psbl_cash), NOT totalDeposit/equity.
 * buyPct remains per-signal fraction of the strategy's buyable cash — never re-read as allocationPct.
 */
import type { AppState, Allocation, Order } from "@/lib/types";
import { CASH_RULE_ID, type UserRule } from "@/src/rules/params";
import { cashFromAllocations } from "@/src/accounts/defaults";

export const ORDERABLE_STALE_MS = 120_000;

export type BudgetMode = "legacy_fixed" | "orderable_ratio";

export type OrderableCashSnapshot = {
  /** null = missing/failed — never treat as 0 */
  orderableCash: number | null;
  depositCash: number | null;
  fetchedAtMs: number | null;
  freshness: "fresh" | "stale" | "unknown" | "missing";
  reason: string | null;
};

export type StrategyBudgetView = {
  ruleId: string;
  budgetMode: BudgetMode;
  /** Strategy allocation ratio of distributable orderable cash (ratio mode). */
  allocationPct: number | null;
  /** Legacy fixed budget (KRW). */
  legacyBudget: number;
  /** Computed strategy cash ceiling for this tick (not persisted as a cash move). */
  computedCashLimit: number | null;
  /** Local open BUY reservations attributed to this rule. */
  reservedBuyKrw: number;
  /** Cash available for a new BUY under this strategy. */
  buyableCash: number | null;
  /** One-shot buy amount from buyPct × buyable, capped by sliceKrw. */
  plannedBuyKrw: number | null;
  blockReason: string | null;
};

function isOpenBuyReservation(order: Order): boolean {
  if (order.side !== "buy") return false;
  if (order.parentOrderId) return false;
  return (
    order.status === "pending" ||
    order.status === "unknown" ||
    order.activeClass === "UNKNOWN_ACTIVE"
  );
}

/** Local BUY notional still reserved (pending/unknown). Do not double-subtract broker-side holds. */
export function reservedBuyKrwForRule(state: Pick<AppState, "orders">, ruleId: string): number {
  return state.orders
    .filter((o) => isOpenBuyReservation(o) && o.ruleId === ruleId)
    .reduce((sum, o) => {
      const remainingQty = Math.max(0, (o.orderedQty ?? o.qty) - (o.filledQty ?? 0));
      if (remainingQty > 0 && o.price > 0) return sum + remainingQty * o.price;
      return sum + Math.max(0, o.amount || o.net || 0);
    }, 0);
}

export function reservedBuyKrwAccount(state: Pick<AppState, "orders">): number {
  return state.orders
    .filter((o) => isOpenBuyReservation(o))
    .reduce((sum, o) => {
      const remainingQty = Math.max(0, (o.orderedQty ?? o.qty) - (o.filledQty ?? 0));
      if (remainingQty > 0 && o.price > 0) return sum + remainingQty * o.price;
      return sum + Math.max(0, o.amount || o.net || 0);
    }, 0);
}

export function readOrderableCashSnapshot(
  state: Pick<AppState, "kisBalance">,
  nowMs = Date.now(),
): OrderableCashSnapshot {
  const bal = state.kisBalance;
  if (!bal) {
    return {
      orderableCash: null,
      depositCash: null,
      fetchedAtMs: null,
      freshness: "missing",
      reason: "KIS 잔고 스냅샷 없음",
    };
  }
  const fetchedAtMs = bal.fetchedAt
    ? Date.parse(bal.fetchedAt)
    : bal.syncedAt
      ? Date.parse(bal.syncedAt)
      : null;
  const ageOk =
    fetchedAtMs != null && Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs <= ORDERABLE_STALE_MS;
  const raw = bal.orderableCash;
  if (raw == null || !Number.isFinite(raw)) {
    return {
      orderableCash: null,
      depositCash: Number.isFinite(bal.cash) ? bal.cash : null,
      fetchedAtMs,
      freshness: "missing",
      reason: "주문가능금액 조회 실패 또는 null",
    };
  }
  if (bal.freshness === "stale" || !ageOk) {
    return {
      orderableCash: raw,
      depositCash: Number.isFinite(bal.cash) ? bal.cash : null,
      fetchedAtMs,
      freshness: "stale",
      reason: "주문가능금액이 stale — 신규 매수 차단",
    };
  }
  if (bal.freshness === "unknown") {
    return {
      orderableCash: raw,
      depositCash: Number.isFinite(bal.cash) ? bal.cash : null,
      fetchedAtMs,
      freshness: "unknown",
      reason: "주문가능금액 신선도 unknown — 신규 매수 차단",
    };
  }
  return {
    orderableCash: raw,
    depositCash: Number.isFinite(bal.cash) ? bal.cash : null,
    fetchedAtMs,
    freshness: "fresh",
    reason: null,
  };
}

/**
 * Distributable orderable cash for ratio allocation.
 * KIS ord_psbl_cash already reflects broker open-order holds — do not subtract local
 * reservations that mirror the same broker holds. Only subtract local reservations
 * that are not yet reflected (unknown / pre-broker) when distinguishable; when unclear, block.
 */
export function distributableOrderableCash(
  snap: OrderableCashSnapshot,
  state: Pick<AppState, "orders">,
): { amount: number | null; blockReason: string | null } {
  if (snap.orderableCash == null) {
    return { amount: null, blockReason: snap.reason ?? "주문가능금액 없음" };
  }
  if (snap.freshness === "stale" || snap.freshness === "unknown" || snap.freshness === "missing") {
    return { amount: null, blockReason: snap.reason ?? "주문가능금액 사용 불가" };
  }
  const unknownLocal = state.orders.some(
    (o) =>
      isOpenBuyReservation(o) &&
      (o.status === "unknown" || o.activeClass === "UNKNOWN_ACTIVE"),
  );
  if (unknownLocal) {
    return {
      amount: null,
      blockReason: "UNKNOWN 예약금 확인 전 — 신규 매수·배분 계산 차단",
    };
  }
  // Pending buys: assume already reflected in KIS orderable — do not double-subtract.
  return { amount: Math.max(0, Math.floor(snap.orderableCash)), blockReason: null };
}

export function ruleBudgetMode(rule: UserRule): BudgetMode {
  if (rule.budgetMode === "orderable_ratio") return "orderable_ratio";
  if (rule.budgetMode === "legacy_fixed") return "legacy_fixed";
  // Explicit ratio field → ratio mode; otherwise preserve legacy fixed budgets.
  if (rule.allocationPct != null && Number.isFinite(rule.allocationPct)) return "orderable_ratio";
  return "legacy_fixed";
}

export function sumActiveAllocationPct(rules: UserRule[]): number {
  return rules
    .filter((r) => r.enabled && ruleBudgetMode(r) === "orderable_ratio")
    .reduce((sum, r) => sum + Math.max(0, r.allocationPct ?? 0), 0);
}

export function validateAllocationPctSum(rules: UserRule[]): string | null {
  const sum = sumActiveAllocationPct(rules);
  if (sum > 1 + 1e-9) {
    return `활성 전략 배정 비율 합계 ${(sum * 100).toFixed(2)}%가 100%를 초과합니다.`;
  }
  for (const rule of rules) {
    if (ruleBudgetMode(rule) !== "orderable_ratio") continue;
    const pct = rule.allocationPct;
    if (pct == null || !Number.isFinite(pct) || pct < 0 || pct > 1) {
      return `전략 ${rule.name || rule.id}의 배정 비율이 올바르지 않습니다.`;
    }
  }
  return null;
}

/** Validate legacy fixed budgets against a known deposit ceiling (when available). */
export function validateLegacyBudgetSum(
  rules: UserRule[],
  depositCeiling: number | null,
): string | null {
  const used = rules
    .filter((r) => r.enabled && ruleBudgetMode(r) === "legacy_fixed")
    .reduce((sum, r) => sum + Math.max(0, r.budget), 0);
  if (depositCeiling != null && Number.isFinite(depositCeiling) && used > depositCeiling + 1e-6) {
    return "활성 레거시 예산 합계가 기준 예수금을 초과합니다.";
  }
  return null;
}

export function computeStrategyCashLimit(
  rule: UserRule,
  distributable: number,
): number {
  if (ruleBudgetMode(rule) === "orderable_ratio") {
    const pct = Math.max(0, Math.min(1, rule.allocationPct ?? 0));
    return Math.floor(distributable * pct);
  }
  return Math.max(0, Math.floor(rule.budget));
}

export function planBuyAmountKrw(input: {
  buyableCash: number;
  buyPct: number;
  sliceKrw: number;
  minAmountKrw: number;
  price: number;
}): { amountKrw: number; qty: number; blockReason: string | null } {
  const { buyableCash, buyPct, sliceKrw, minAmountKrw, price } = input;
  if (!(price > 0) || !Number.isFinite(price)) {
    return { amountKrw: 0, qty: 0, blockReason: "시세 없음" };
  }
  if (!(buyableCash > 0)) {
    return { amountKrw: 0, qty: 0, blockReason: "매수가능금액 0" };
  }
  const pct = Math.max(0, Math.min(1, buyPct));
  const raw = Math.floor(buyableCash * pct);
  const capped = Math.min(raw, Math.max(0, Math.floor(sliceKrw)));
  if (capped < minAmountKrw) {
    return { amountKrw: capped, qty: 0, blockReason: "최소 매수 금액 미달" };
  }
  const qty = Math.floor(capped / price);
  if (qty < 1) {
    // Never force-up to 1 share when cash cannot cover it.
    return { amountKrw: capped, qty: 0, blockReason: "1주 매수 자금 부족" };
  }
  return { amountKrw: qty * price, qty, blockReason: null };
}

export function strategyBudgetView(
  state: AppState,
  rule: UserRule,
  nowMs = Date.now(),
): StrategyBudgetView {
  const mode = ruleBudgetMode(rule);
  const snap = readOrderableCashSnapshot(state, nowMs);
  const dist = distributableOrderableCash(snap, state);
  const reserved = reservedBuyKrwForRule(state, rule.id);
  const alloc = state.allocations.find((a) => a.ruleId === rule.id);

  if (mode === "orderable_ratio") {
    if (dist.amount == null) {
      return {
        ruleId: rule.id,
        budgetMode: mode,
        allocationPct: rule.allocationPct ?? null,
        legacyBudget: rule.budget,
        computedCashLimit: null,
        reservedBuyKrw: reserved,
        buyableCash: null,
        plannedBuyKrw: null,
        blockReason: dist.blockReason,
      };
    }
    const limit = computeStrategyCashLimit(rule, dist.amount);
    // Ratio mode: computed ceiling is the buy authority — not a ledger cash mint/move.
    const buyable = Math.max(0, limit - reserved);
    const planned = planBuyAmountKrw({
      buyableCash: buyable,
      buyPct: rule.buyPct,
      sliceKrw: rule.sliceKrw,
      minAmountKrw: rule.minAmountKrw,
      price: state.quotes[rule.ticker]?.price ?? 0,
    });
    return {
      ruleId: rule.id,
      budgetMode: mode,
      allocationPct: rule.allocationPct ?? null,
      legacyBudget: rule.budget,
      computedCashLimit: limit,
      reservedBuyKrw: reserved,
      buyableCash: buyable,
      plannedBuyKrw: planned.blockReason ? null : planned.amountKrw,
      blockReason: planned.blockReason,
    };
  }

  const limit = Math.max(0, rule.budget);
  const bucketBal = alloc?.balance ?? limit;
  const buyable = Math.max(0, Math.min(limit, bucketBal) - reserved);
  const planned = planBuyAmountKrw({
    buyableCash: buyable,
    buyPct: rule.buyPct,
    sliceKrw: rule.sliceKrw,
    minAmountKrw: rule.minAmountKrw,
    price: state.quotes[rule.ticker]?.price ?? 0,
  });
  return {
    ruleId: rule.id,
    budgetMode: mode,
    allocationPct: null,
    legacyBudget: rule.budget,
    computedCashLimit: limit,
    reservedBuyKrw: reserved,
    buyableCash: buyable,
    plannedBuyKrw: planned.blockReason ? null : planned.amountKrw,
    blockReason: planned.blockReason,
  };
}

/**
 * Apply ratio/legacy budgets onto allocation rows WITHOUT inventing cash or wiping positions.
 * Computed KRW limits update `budget` display fields only when syncing config — balances
 * are preserved; cash total is conserved via the cash bucket.
 */
export function applyBudgetSync(
  state: AppState,
  rules: UserRule[],
): AppState {
  const prev = new Map(state.allocations.map((row) => [row.ruleId, row]));
  const snap = readOrderableCashSnapshot(state);
  const dist = distributableOrderableCash(snap, state);

  const ratioErr = validateAllocationPctSum(rules);
  if (ratioErr) throw new Error(ratioErr);

  // Ceiling for legacy sum: prefer deposit snapshot, else prior totalDeposit (may be 0).
  const depositCeiling =
    snap.depositCash != null
      ? snap.depositCash
      : Number.isFinite(state.totalDeposit)
        ? state.totalDeposit
        : null;
  const legacyErr = validateLegacyBudgetSum(rules, depositCeiling);
  if (legacyErr) throw new Error(legacyErr);

  const allocations: Allocation[] = [];
  let assignedBudget = 0;
  let seededNewLegacy = 0;

  for (const rule of rules) {
    const prior = prev.get(rule.id);
    const mode = ruleBudgetMode(rule);
    let budget: number;
    if (mode === "orderable_ratio") {
      if (dist.amount == null) {
        budget = prior?.budget ?? 0;
      } else {
        budget = computeStrategyCashLimit(rule, dist.amount);
      }
    } else {
      budget = Math.max(0, Math.floor(rule.budget));
    }
    assignedBudget += rule.enabled ? budget : 0;
    let balance: number;
    if (prior) {
      balance = prior.balance;
    } else if (mode === "legacy_fixed") {
      balance = budget;
      seededNewLegacy += budget;
    } else {
      balance = 0;
    }
    allocations.push({
      ruleId: rule.id,
      budget,
      balance,
      enabled: rule.enabled,
      lastRunAt: prior?.lastRunAt,
      lastMessage: prior?.lastMessage,
      meta: {
        ...(prior?.meta ?? {}),
        budgetMode: mode,
        ...(mode === "orderable_ratio" ? { allocationPct: rule.allocationPct ?? 0 } : {}),
      },
    });
  }

  const cashPrior = prev.get(CASH_RULE_ID);
  const ceiling =
    snap.depositCash != null
      ? snap.depositCash
      : Math.max(state.totalDeposit, cashFromAllocations(state.allocations));
  const cashBudget = Math.max(0, Math.floor(ceiling - assignedBudget));

  const othersBal = allocations.reduce((sum, row) => sum + row.balance, 0);
  let cashBalance: number;
  if (cashPrior && seededNewLegacy === 0) {
    // Config-only / ratio refresh: preserve cash balance exactly (no mint, no silent reshape).
    cashBalance = cashPrior.balance;
  } else if (seededNewLegacy > 0) {
    // Legacy first-time seed: fund from cash bucket when possible; otherwise from
    // ceiling − others (same conservation as historical syncAllocationsToRules).
    if (cashPrior && cashPrior.balance >= seededNewLegacy) {
      cashBalance = cashPrior.balance - seededNewLegacy;
    } else if (ceiling + 1e-6 >= othersBal) {
      cashBalance = Math.max(0, Math.floor(ceiling - othersBal));
    } else {
      throw new Error("현금 버킷 잔액이 부족하여 신규 레거시 예산을 배정할 수 없습니다.");
    }
  } else {
    cashBalance = Math.max(0, Math.floor(ceiling - othersBal));
  }

  allocations.unshift({
    ruleId: CASH_RULE_ID,
    budget: cashBudget,
    balance: cashBalance,
    enabled: true,
    lastMessage: cashPrior?.lastMessage ?? "사용자 예수금",
    meta: cashPrior?.meta ?? {},
  });

  const totalBal = cashFromAllocations(allocations);
  if (totalBal > ceiling + 1e-6 && seededNewLegacy > 0) {
    throw new Error("배분 잔액 합계가 기준 예수금을 초과합니다.");
  }

  return {
    ...state,
    allocations,
    cash: totalBal,
    positions: state.positions,
    orders: state.orders,
    intents: state.intents,
  };
}

/** Convert legacy fixed budget → allocationPct given a fresh orderable base. */
export function convertLegacyToRatio(
  legacyBudget: number,
  orderableCash: number | null,
): { allocationPct: number; computedCashLimit: number } | { error: string } {
  if (orderableCash == null || !Number.isFinite(orderableCash) || orderableCash <= 0) {
    return { error: "전환 기준 주문가능금액이 없습니다." };
  }
  if (!(legacyBudget >= 0) || !Number.isFinite(legacyBudget)) {
    return { error: "레거시 예산이 올바르지 않습니다." };
  }
  const pct = legacyBudget / orderableCash;
  if (pct > 1 + 1e-9) {
    return { error: "환산 비율이 100%를 초과합니다." };
  }
  const allocationPct = Math.min(1, Math.max(0, pct));
  return {
    allocationPct,
    computedCashLimit: Math.floor(orderableCash * allocationPct),
  };
}
