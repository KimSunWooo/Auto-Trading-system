import { cashFromAllocations, DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import type { Allocation, AppState } from "@/lib/types";

export class AllocationEngine {
  static defaults(): Allocation[] {
    return DEFAULT_ALLOCATIONS.map((row) => ({ ...row }));
  }

  static rebalance(
    state: AppState,
    next: Array<Pick<Allocation, "ruleId" | "budget"> & Partial<Allocation>>,
  ): AppState {
    const budgetSum = next.reduce((sum, row) => sum + row.budget, 0);
    if (budgetSum > state.totalDeposit) {
      throw new Error("배분 합계가 총 예수금을 초과합니다.");
    }
    const allocations: Allocation[] = next.map((row) => ({
      ruleId: row.ruleId,
      budget: row.budget,
      balance: row.budget,
      enabled: row.enabled ?? true,
      meta: {},
    }));
    return {
      ...state,
      allocations,
      cash: cashFromAllocations(allocations),
      positions: [],
      orders: state.orders,
    };
  }

  static patch(
    state: AppState,
    ruleId: string,
    patch: Partial<Pick<Allocation, "enabled" | "budget" | "lastMessage">>,
  ): AppState {
    const allocations = state.allocations.map((row) => {
      if (row.ruleId !== ruleId) return row;
      const next: Allocation = { ...row };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.lastMessage !== undefined) next.lastMessage = patch.lastMessage;
      if (patch.budget !== undefined) {
        const delta = patch.budget - row.budget;
        next.budget = patch.budget;
        next.balance = Math.max(0, row.balance + delta);
      }
      return next;
    });
    return {
      ...state,
      allocations,
      cash: cashFromAllocations(allocations),
    };
  }

  static seedTotalDeposit(): number {
    return TOTAL_DEPOSIT;
  }
}
