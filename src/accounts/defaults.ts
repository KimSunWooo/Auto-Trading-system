import type { Allocation } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";

/**
 * Strategy ledger starting point — NOT broker deposit.
 * Broker cash authority is KIS dnca_tot_amt after Startup Sync.
 */
export const TOTAL_DEPOSIT = 0;
export { CASH_RULE_ID };

/** Working cash ledger only. No preset trading rules. No mock 10M deposit. */
export const DEFAULT_ALLOCATIONS: Allocation[] = [
  {
    ruleId: CASH_RULE_ID,
    budget: 0,
    balance: 0,
    enabled: true,
    lastMessage: "전략 배정 잔액 (KIS 예수금과 별개)",
  },
];

export function cashFromAllocations(allocations: Allocation[]): number {
  return allocations.reduce((sum, row) => sum + row.balance, 0);
}
