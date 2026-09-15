import type { AppState, Position, Quote } from "@/lib/types";

export function accountValue(state: {
  cash: number;
  positions: Position[];
  quotes: Record<string, Quote>;
}): number {
  const holdings = state.positions.reduce((sum, p) => {
    const quote = state.quotes[p.code];
    return sum + p.qty * (quote?.price ?? p.avgPrice);
  }, 0);
  return state.cash + holdings;
}

/** @deprecated Use accountValue */
export const portfolioValue = accountValue;

export function ruleEquity(
  state: Pick<AppState, "allocations" | "positions" | "quotes">,
  ruleId: string,
): number {
  const bucket = state.allocations.find((row) => row.ruleId === ruleId);
  const cash = bucket?.balance ?? 0;
  const held = state.positions
    .filter((p) => p.ruleId === ruleId)
    .reduce((sum, p) => {
      const quote = state.quotes[p.code];
      return sum + p.qty * (quote?.price ?? p.avgPrice);
    }, 0);
  return cash + held;
}
