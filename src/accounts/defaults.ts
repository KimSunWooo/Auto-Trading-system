import type { Allocation } from "@/lib/types";
import {
  AGGRESSIVE_UNIVERSE,
  KODEX_200,
  SWING_TICKER,
} from "@/src/strategies/params";

export const TOTAL_DEPOSIT = 10_000_000;

/** Default paper split: 70% defensive ETF, 30% aggressive overlay. */
export const DEFAULT_ALLOCATIONS: Allocation[] = [
  {
    strategy: "Level1_Stable",
    riskLevel: 1,
    budget: 7_000_000,
    balance: 7_000_000,
    enabled: true,
  },
  {
    strategy: "Level10_Aggressive",
    riskLevel: 10,
    budget: 3_000_000,
    balance: 3_000_000,
    enabled: true,
  },
];

export { KODEX_200, SWING_TICKER, AGGRESSIVE_UNIVERSE };

export function cashFromAllocations(allocations: Allocation[]): number {
  return allocations.reduce((sum, row) => sum + row.balance, 0);
}
