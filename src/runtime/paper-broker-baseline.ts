/**
 * KIS PAPER broker cash baseline — first successful sync only.
 * User-entered / default TOTAL_DEPOSIT never becomes PAPER deposit authority.
 */
import { cashFromAllocations } from "@/src/accounts/defaults";
import type { Allocation, AppState, PaperBrokerBaseline } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";
import { seoulDay } from "@/src/risk/limits";
import { usesPaperBrokerBalanceSemantics } from "@/src/risk/kis-balance-semantics";
import { type EnvMap } from "@/src/brokers/kis-config";
import { emptyCircuit } from "@/src/risk/circuit";
import { emptySafety } from "@/src/runtime/safety";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";

export function needsPaperBrokerBaseline(
  state: AppState,
  env: EnvMap = process.env,
): boolean {
  if (!usesPaperBrokerBalanceSemantics(env)) return false;
  return !state.paperBrokerBaseline;
}

/**
 * Initialize local risk/strategy deposit baseline from KIS dnca_tot_amt once.
 * Does not invent equity; uses broker deposit cash only.
 * Preserves non-cash rule budgets; rebases cash bucket to remainder.
 */
export function applyPaperBrokerBaseline(
  state: AppState,
  depositCash: number,
): AppState {
  if (state.paperBrokerBaseline) return state;
  const cash = Math.max(0, Math.round(depositCash));
  const rules = state.allocations.filter((row) => row.ruleId !== CASH_RULE_ID);
  const used = rules.reduce((sum, row) => sum + Math.max(0, row.budget), 0);
  const cashBudget = Math.max(0, cash - used);
  const cashRow: Allocation = {
    ruleId: CASH_RULE_ID,
    budget: cashBudget,
    balance: cashBudget,
    enabled: true,
    lastMessage: "KIS PAPER 예수금 기준",
  };
  const allocations = [cashRow, ...rules.map((row) => ({ ...row }))];
  const baseline: PaperBrokerBaseline = {
    source: "KIS_PAPER",
    initializedAt: new Date().toISOString(),
    depositCash: cash,
  };
  return {
    ...state,
    totalDeposit: cash,
    settings: {
      ...state.settings,
      startingCash: cash,
    },
    allocations,
    cash: cashFromAllocations(allocations),
    dayStart: { date: seoulDay(), equity: cash },
    equityHistory: [cash],
    paperBrokerBaseline: baseline,
  };
}

/** PAPER account reset: clear seed 10M; require fresh Startup Sync + baseline. */
export function createPaperAccountResetState(): AppState {
  const cashRow: Allocation = {
    ruleId: CASH_RULE_ID,
    budget: 0,
    balance: 0,
    enabled: true,
    lastMessage: "KIS PAPER sync 대기",
  };
  return {
    updatedAt: new Date().toISOString(),
    tickCount: 0,
    settings: {
      ignoreMarketHours: true,
      startingCash: 0,
      broker: "kis",
      autoTrading: false,
      onboardingComplete: false,
      liquidating: false,
      disclaimerAccepted: false,
      risk: { ...DEFAULT_PRODUCT_RISK },
    },
    totalDeposit: 0,
    allocations: [cashRow],
    cash: 0,
    positions: [],
    quotes: {},
    conditions: [],
    dcaPlans: [],
    orders: [],
    circuit: emptyCircuit(),
    dayStart: { date: "", equity: 0 },
    equityHistory: [0],
    kisBalance: undefined,
    paperBrokerBaseline: undefined,
    startupSync: {
      status: "IDLE",
      recoveredOrders: 0,
      orphanedOrders: 0,
      positionChanges: 0,
      executionChanges: 0,
    },
    intents: [],
    safety: emptySafety(),
  };
}

export function paperBalanceReadyForOnboarding(state: AppState): string | null {
  if (state.startupSync?.status !== "HEALTHY") {
    return "PAPER Startup Sync HEALTHY가 필요합니다.";
  }
  if (!state.kisBalance || state.kisBalance.freshness !== "fresh") {
    return "KIS PAPER 잔고가 아직 fresh 하지 않습니다.";
  }
  if (!(state.kisBalance.cash >= 0) || !Number.isFinite(state.kisBalance.cash)) {
    return "KIS PAPER 예수금(dnca_tot_amt)을 읽지 못했습니다.";
  }
  if (!state.paperBrokerBaseline) {
    return "KIS PAPER broker baseline이 아직 초기되지 않았습니다.";
  }
  return null;
}
