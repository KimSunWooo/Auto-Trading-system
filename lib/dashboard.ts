import { seoulDay } from "@/src/risk/limits";
import type { PublicState } from "@/lib/types";
import { accountValue, ruleEquity } from "@/src/accounts/portfolio";
import type { UserRule } from "@/src/rules/params";

export function dashboardStats(state: PublicState) {
  const equity = state.equity ?? accountValue(state);
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

export function ruleCardModel(state: PublicState, rule: UserRule) {
  const alloc = state.allocations.find((row) => row.ruleId === rule.id);
  const equity = alloc ? ruleEquity(state, rule.id) : 0;
  const budget = alloc?.budget ?? rule.budget;
  const ret = budget > 0 ? ((equity - budget) / budget) * 100 : 0;
  return {
    id: rule.id,
    name: rule.name || rule.ticker,
    ticker: rule.ticker,
    kindLabel: rule.kind === "ma-cross" ? `이평 ${rule.fastMa}/${rule.slowMa}` : `실행 주기 ${Math.round(rule.intervalMs / 1000)}초`,
    allocated: Boolean(alloc),
    enabled: alloc?.enabled ?? rule.enabled,
    budget,
    balance: alloc?.balance ?? 0,
    equity,
    returnPct: ret,
    lastMessage: alloc?.lastMessage,
  };
}
