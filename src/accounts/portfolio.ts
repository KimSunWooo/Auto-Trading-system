import type { AppState, Position, Quote } from "@/lib/types";

export function portfolioValue(state: {
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

export function strategyEquity(
  state: Pick<AppState, "allocations" | "positions" | "quotes">,
  strategy: string,
): number {
  const bucket = state.allocations.find((row) => row.strategy === strategy);
  const cash = bucket?.balance ?? 0;
  const held = state.positions
    .filter((p) => p.strategy === strategy)
    .reduce((sum, p) => {
      const quote = state.quotes[p.code];
      return sum + p.qty * (quote?.price ?? p.avgPrice);
    }, 0);
  return cash + held;
}
