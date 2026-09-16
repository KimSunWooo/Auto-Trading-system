import { money, moneyNumber } from "@/src/db/money";
import { newId } from "@/src/db/ids";
import type { ExecutionRow, TradeRow } from "@/src/db/rows";

/** Weighted-average remaining cost — same formula as `src/accounts/fills.ts`. */
export function applyExecutionToTrade(trade: TradeRow, execution: ExecutionRow): TradeRow {
  const qty = moneyNumber(execution.quantity);
  const price = moneyNumber(execution.price);
  const commission = moneyNumber(execution.commission);
  const tax = moneyNumber(execution.tax);
  const other = moneyNumber(execution.otherFee);
  const remainingQty = moneyNumber(trade.totalBuyQty) - moneyNumber(trade.totalSellQty);
  const remainingAvg = moneyNumber(trade.averageBuyPrice) || 0;

  if (execution.side === "BUY") {
    const nextQty = remainingQty + qty;
    const nextAvg = nextQty > 0 ? (remainingAvg * remainingQty + price * qty) / nextQty : remainingAvg;
    const totalBuyQty = moneyNumber(trade.totalBuyQty) + qty;
    const totalBuyAmount = moneyNumber(trade.totalBuyAmount) + price * qty;
    const status = moneyNumber(trade.totalSellQty) > 0 ? "PARTIALLY_CLOSED" : "OPEN";
    return {
      ...trade,
      status,
      totalBuyQty: money(totalBuyQty),
      totalBuyAmount: money(totalBuyAmount),
      averageBuyPrice: money(nextAvg),
      totalCommission: money(moneyNumber(trade.totalCommission) + commission),
      totalTax: money(moneyNumber(trade.totalTax) + tax),
      totalOtherFee: money(moneyNumber(trade.totalOtherFee) + other),
      closedAt: null,
    };
  }

  const realized = Math.round((price - remainingAvg) * qty - commission - tax - other);
  const totalSellQty = moneyNumber(trade.totalSellQty) + qty;
  const totalSellAmount = moneyNumber(trade.totalSellAmount) + price * qty;
  const leftover = remainingQty - qty;
  const averageSellPrice = totalSellQty > 0 ? totalSellAmount / totalSellQty : null;
  const realizedPnl = moneyNumber(trade.realizedPnl) + realized;
  const buyAmt = moneyNumber(trade.totalBuyAmount);
  const realizedReturnPct = buyAmt > 0 ? realizedPnl / buyAmt : null;
  const closed = leftover <= 1e-12;
  return {
    ...trade,
    status: closed ? "CLOSED" : "PARTIALLY_CLOSED",
    totalSellQty: money(totalSellQty),
    totalSellAmount: money(totalSellAmount),
    averageSellPrice: averageSellPrice == null ? null : money(averageSellPrice),
    totalCommission: money(moneyNumber(trade.totalCommission) + commission),
    totalTax: money(moneyNumber(trade.totalTax) + tax),
    totalOtherFee: money(moneyNumber(trade.totalOtherFee) + other),
    realizedPnl: money(realizedPnl),
    realizedReturnPct: realizedReturnPct == null ? null : money(realizedReturnPct),
    closedAt: closed ? execution.executedAt : null,
  };
}

export function openTrade(input: {
  brokerAccountId: string;
  instrumentId: string;
  ruleScope: string;
  source: string;
  currency: string;
  openedAt: string;
}): TradeRow {
  return {
    id: newId(),
    brokerAccountId: input.brokerAccountId,
    instrumentId: input.instrumentId,
    ruleScope: input.ruleScope,
    source: input.source,
    status: "OPEN",
    totalBuyQty: money(0),
    totalSellQty: money(0),
    totalBuyAmount: money(0),
    totalSellAmount: money(0),
    averageBuyPrice: null,
    averageSellPrice: null,
    totalCommission: money(0),
    totalTax: money(0),
    totalOtherFee: money(0),
    realizedPnl: money(0),
    realizedReturnPct: null,
    currency: input.currency,
    openedAt: input.openedAt,
    closedAt: null,
  };
}
