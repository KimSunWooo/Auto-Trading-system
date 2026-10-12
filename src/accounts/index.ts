import { cashFromAllocations, DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import type { Allocation, AppState } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";

export class AllocationEngine {
  static defaults(): Allocation[] {
    return DEFAULT_ALLOCATIONS.map((row) => ({ ...row }));
  }

  /**
   * Rebalance budgets across rules. Preserves positions, orders, intents, and
   * existing per-bucket balances (no position wipe, no fake cash mint).
   */
  static rebalance(
    state: AppState,
    next: Array<Pick<Allocation, "ruleId" | "budget"> & Partial<Allocation>>,
  ): AppState {
    const budgetSum = next.reduce((sum, row) => sum + Math.max(0, row.budget), 0);
    const ceiling = Math.max(
      0,
      state.kisBalance?.cash ?? state.totalDeposit ?? cashFromAllocations(state.allocations),
    );
    if (budgetSum > ceiling + 1e-6) {
      throw new Error("배분 합계가 총 예수금을 초과합니다.");
    }
    const prev = new Map(state.allocations.map((row) => [row.ruleId, row]));
    const allocations: Allocation[] = next.map((row) => {
      const prior = prev.get(row.ruleId);
      return {
        ruleId: row.ruleId,
        budget: Math.max(0, Math.floor(row.budget)),
        // Preserve balance — budget change alone does not mint or destroy cash.
        balance: prior?.balance ?? 0,
        enabled: row.enabled ?? prior?.enabled ?? true,
        lastRunAt: prior?.lastRunAt,
        lastMessage: row.lastMessage ?? prior?.lastMessage,
        meta: { ...(prior?.meta ?? {}), ...(row.meta ?? {}) },
      };
    });
    if (!allocations.some((row) => row.ruleId === CASH_RULE_ID)) {
      const cashPrior = prev.get(CASH_RULE_ID);
      const othersBal = allocations.reduce((sum, row) => sum + row.balance, 0);
      allocations.unshift({
        ruleId: CASH_RULE_ID,
        budget: Math.max(0, Math.floor(ceiling - budgetSum)),
        balance: Math.max(0, Math.floor(ceiling - othersBal)),
        enabled: true,
        lastMessage: cashPrior?.lastMessage ?? "사용자 예수금",
        meta: cashPrior?.meta ?? {},
      });
    }
    return {
      ...state,
      allocations,
      cash: cashFromAllocations(allocations),
      // CRITICAL: never wipe positions on rebalance.
      positions: state.positions,
      orders: state.orders,
      intents: state.intents,
    };
  }

  /**
   * Patch a single allocation. Budget changes adjust the budget field and move
   * cash between the target bucket and the cash bucket — never mint new cash.
   */
  static patch(
    state: AppState,
    ruleId: string,
    patch: Partial<Pick<Allocation, "enabled" | "budget" | "lastMessage">>,
  ): AppState {
    if (patch.budget !== undefined) {
      if (!Number.isFinite(patch.budget) || patch.budget < 0) {
        throw new Error("예산이 올바르지 않습니다.");
      }
    }

    const allocations = state.allocations.map((row) => ({ ...row }));
    const idx = allocations.findIndex((row) => row.ruleId === ruleId);
    if (idx < 0) throw new Error("배분 대상을 찾을 수 없습니다.");

    const target = { ...allocations[idx]! };
    const cashIdx = allocations.findIndex((row) => row.ruleId === CASH_RULE_ID);

    if (patch.enabled !== undefined) target.enabled = patch.enabled;
    if (patch.lastMessage !== undefined) target.lastMessage = patch.lastMessage;

    if (patch.budget !== undefined && patch.budget !== target.budget) {
      const delta = patch.budget - target.budget;
      // Increasing budget: take from cash bucket balance+budget; never mint.
      if (delta > 0) {
        if (cashIdx < 0) throw new Error("현금 버킷이 없어 예산을 늘릴 수 없습니다.");
        const cash = allocations[cashIdx]!;
        if (cash.balance < delta) {
          throw new Error("현금 버킷 잔액이 부족하여 예산을 늘릴 수 없습니다.");
        }
        allocations[cashIdx] = {
          ...cash,
          budget: Math.max(0, cash.budget - delta),
          balance: cash.balance - delta,
        };
        target.budget = patch.budget;
        target.balance = target.balance + delta;
      } else {
        // Decreasing budget: return unused cash portion to cash bucket; never delete positions.
        const reduce = -delta;
        const movable = Math.min(reduce, target.balance);
        target.budget = patch.budget;
        target.balance = target.balance - movable;
        if (cashIdx >= 0) {
          const cash = allocations[cashIdx]!;
          allocations[cashIdx] = {
            ...cash,
            budget: cash.budget + reduce,
            balance: cash.balance + movable,
          };
        }
      }
    }

    allocations[idx] = target;
    return {
      ...state,
      allocations,
      cash: cashFromAllocations(allocations),
      positions: state.positions,
      orders: state.orders,
      intents: state.intents,
    };
  }

  static seedTotalDeposit(): number {
    return TOTAL_DEPOSIT;
  }
}
