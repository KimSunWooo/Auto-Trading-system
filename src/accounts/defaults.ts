import type { Allocation } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";

export const TOTAL_DEPOSIT = 10_000_000;
export { CASH_RULE_ID };

/** Working cash ledger only. No preset trading rules. */
export const DEFAULT_ALLOCATIONS: Allocation[] = [
  {
    ruleId: CASH_RULE_ID,
    budget: TOTAL_DEPOSIT,
    balance: TOTAL_DEPOSIT,
    enabled: true,
    lastMessage: "사용자 예수금",
  },
];

export function cashFromAllocations(allocations: Allocation[]): number {
  return allocations.reduce((sum, row) => sum + row.balance, 0);
}
