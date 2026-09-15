import { seoulDay } from "@/src/risk/limits";
import type { PublicState } from "@/lib/types";
import { portfolioValue, strategyEquity } from "@/src/accounts/portfolio";
import { playbookById } from "@/lib/playbooks";

export function dashboardStats(state: PublicState) {
  const equity = state.equity ?? portfolioValue(state);
  const pnl = equity - state.settings.startingCash;
  const pnlPct = state.settings.startingCash > 0 ? (pnl / state.settings.startingCash) * 100 : 0;
  const today = seoulDay();
  const todays = state.orders.filter(
    (order) =>
      !order.parentOrderId &&
      order.status === "filled" &&
      seoulDay(new Date(order.createdAt)) === today,
  );
  const sells = todays.filter((order) => order.side === "sell" && order.realizedPnl != null);
  const wins = sells.filter((order) => (order.realizedPnl ?? 0) > 0);
  return {
    equity,
    pnl,
    pnlPct,
    tradesToday: todays.length,
    winRatePct: sells.length ? (wins.length / sells.length) * 100 : null,
    dayStartEquity: state.dayStart?.equity ?? state.settings.startingCash,
  };
}

export function strategyCardModel(state: PublicState, strategy: string) {
  const alloc = state.allocations.find((row) => row.strategy === strategy);
  const book = playbookById(strategy);
  const equity = alloc ? strategyEquity(state, strategy) : 0;
  const budget = alloc?.budget ?? 0;
  const ret = budget > 0 ? ((equity - budget) / budget) * 100 : 0;
  return {
    ...book,
    allocated: Boolean(alloc),
    enabled: alloc?.enabled ?? false,
    budget,
    balance: alloc?.balance ?? 0,
    equity,
    returnPct: ret,
    lastMessage: alloc?.lastMessage,
  };
}
