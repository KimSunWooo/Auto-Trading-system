/**
 * AI PAPER budget policy — ADMIN-configured, ATS-enforced.
 * Auto-orders stay disabled until priorities 1–5 are proven.
 *
 * Absolute AI usage cap = 1.10 × A when admin enables 10% overdraft from
 * unallocated cash. This is NOT +10% per order.
 */
export type AiBudgetPolicy = {
  /** Base AI allocation A (KRW). */
  allocationKrw: number;
  /** Allow usage up to 1.10 × A from unallocated cash. */
  allowTenPercentOverdraft: boolean;
  /** Max concurrent AI-attributed holdings. */
  maxConcurrentSymbols: number;
  /** Optional daily buy notional (KRW). */
  maxDailyBuyKrw: number | null;
  /** Daily loss halt threshold (KRW, absolute). */
  maxDailyLossKrw: number | null;
  /** Cash reserve ratio 0..1 kept unspent. */
  cashReserveRatio: number;
  /** Re-entry wait after exit (ms). */
  reentryCooldownMs: number;
  allowedTickers: string[];
  excludedTickers: string[];
  allowedModelVersions: string[];
  allowedPolicyVersions: string[];
  proposalMaxAgeMs: number;
  /** When false, no AI-originated orders are submitted. */
  autoOrderEnabled: boolean;
  /** Halt new AI orders without flattening. */
  haltNewAiOrders: boolean;
};

export const DEFAULT_AI_BUDGET_POLICY: AiBudgetPolicy = {
  allocationKrw: 0,
  allowTenPercentOverdraft: false,
  maxConcurrentSymbols: 5,
  maxDailyBuyKrw: null,
  maxDailyLossKrw: null,
  cashReserveRatio: 0.05,
  reentryCooldownMs: 0,
  allowedTickers: [],
  excludedTickers: [],
  allowedModelVersions: [],
  allowedPolicyVersions: [],
  proposalMaxAgeMs: 15 * 60_000,
  autoOrderEnabled: false,
  haltNewAiOrders: true,
};

export type AiBudgetUsage = {
  /** Acquisition cost of AI-attributed positions. */
  positionCostKrw: number;
  /** Reserved notional for open AI BUY intents. */
  reservedBuyKrw: number;
};

export type AiBudgetCheck = {
  ok: boolean;
  reason?: string;
  allocationKrw: number;
  absoluteCapKrw: number;
  usedKrw: number;
  remainingKrw: number;
};

export function aiAbsoluteCapKrw(policy: AiBudgetPolicy): number {
  const a = Math.max(0, policy.allocationKrw);
  return policy.allowTenPercentOverdraft ? a * 1.1 : a;
}

export function checkAiBuyBudget(input: {
  policy: AiBudgetPolicy;
  usage: AiBudgetUsage;
  orderNotionalKrw: number;
  unallocatedCashKrw: number;
  kisOrderableCashKrw: number;
}): AiBudgetCheck {
  const { policy, usage, orderNotionalKrw } = input;
  const allocationKrw = Math.max(0, policy.allocationKrw);
  const absoluteCapKrw = aiAbsoluteCapKrw(policy);
  const usedKrw = Math.max(0, usage.positionCostKrw) + Math.max(0, usage.reservedBuyKrw);
  const remainingKrw = Math.max(0, absoluteCapKrw - usedKrw);

  const base: AiBudgetCheck = {
    ok: false,
    allocationKrw,
    absoluteCapKrw,
    usedKrw,
    remainingKrw,
  };

  if (!policy.autoOrderEnabled || policy.haltNewAiOrders) {
    return { ...base, reason: "AI auto-order disabled or halted" };
  }
  if (allocationKrw <= 0) {
    return { ...base, reason: "AI allocation A is 0" };
  }
  if (orderNotionalKrw <= 0) {
    return { ...base, reason: "order notional must be positive" };
  }
  if (usedKrw + orderNotionalKrw > absoluteCapKrw + 1e-6) {
    return {
      ...base,
      reason: `AI usage would exceed absolute cap 1.10×A=${absoluteCapKrw}`,
    };
  }
  // Overdraft beyond A must come from unallocated cash only.
  const overdraftNeeded = Math.max(0, usedKrw + orderNotionalKrw - allocationKrw);
  if (overdraftNeeded > 0) {
    if (!policy.allowTenPercentOverdraft) {
      return { ...base, reason: "overdraft beyond A not allowed" };
    }
    if (overdraftNeeded > input.unallocatedCashKrw + 1e-6) {
      return { ...base, reason: "overdraft exceeds unallocated cash" };
    }
  }
  const reserve = input.kisOrderableCashKrw * policy.cashReserveRatio;
  if (orderNotionalKrw > input.kisOrderableCashKrw - reserve + 1e-6) {
    return { ...base, reason: "KIS orderable cash / reserve insufficient" };
  }
  return { ...base, ok: true, remainingKrw: remainingKrw - orderNotionalKrw };
}
