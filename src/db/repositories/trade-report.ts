import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import { executions, instruments, trades, tradingRules } from "@/src/db/schema";
import { toMysqlUtc } from "@/src/db/time";
import { seoulDay } from "@/src/risk/limits";

export const REPORT_PERIODS = [7, 30, 90] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export type ReportCurrency = "KRW" | "USD";

export function reportDateRange(days: ReportPeriod, now = new Date()) {
  const today = Date.parse(`${seoulDay(now)}T00:00:00+09:00`);
  const dayMs = 86_400_000;
  const from = today - (days - 1) * dayMs;
  return {
    fromUtc: toMysqlUtc(from),
    untilUtc: toMysqlUtc(today + dayMs),
    fromDate: seoulDay(new Date(from)),
    throughDate: seoulDay(now),
  };
}

export type TradeReportGroup = {
  day: string;
  ruleKey: string;
  ruleName: string | null;
  closedCount: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  holdingSeconds: number;
};

export function summarizeClosedTrades(groups: readonly TradeReportGroup[]) {
  const summary = { closedCount: 0, wins: 0, losses: 0, realizedPnl: 0, holdingSeconds: 0 };
  const days = new Map<string, number>();
  const strategies = new Map<
    string,
    {
      ruleKey: string;
      name: string;
      closedCount: number;
      wins: number;
      realizedPnl: number;
    }
  >();

  for (const group of groups) {
    summary.closedCount += group.closedCount;
    summary.wins += group.wins;
    summary.losses += group.losses;
    summary.realizedPnl += group.realizedPnl;
    summary.holdingSeconds += group.holdingSeconds;
    days.set(group.day, (days.get(group.day) ?? 0) + group.realizedPnl);
    const rule = strategies.get(group.ruleKey) ?? {
      ruleKey: group.ruleKey,
      name: group.ruleKey === "cash" ? "현금 버킷" : (group.ruleName ?? group.ruleKey),
      closedCount: 0,
      wins: 0,
      realizedPnl: 0,
    };
    rule.closedCount += group.closedCount;
    rule.wins += group.wins;
    rule.realizedPnl += group.realizedPnl;
    strategies.set(group.ruleKey, rule);
  }

  return {
    ...summary,
    flat: summary.closedCount - summary.wins - summary.losses,
    winRate: summary.closedCount ? summary.wins / summary.closedCount : null,
    averageHoldingSeconds: summary.closedCount
      ? summary.holdingSeconds / summary.closedCount
      : null,
    daily: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, pnl]) => ({ day, pnl })),
    byStrategy: [...strategies.values()].sort(
      (a, b) => b.closedCount - a.closedCount || a.name.localeCompare(b.name, "ko"),
    ),
  };
}

export type PaperTradeReport = Awaited<ReturnType<typeof getPaperTradeReport>>;

export async function getPaperTradeReport(
  accountId: string,
  period: ReportPeriod,
  currency: ReportCurrency,
) {
  const db = getDb();
  if (!db) throw new Error("Trading ledger is unavailable");
  const range = reportDateRange(period);
  const closed = and(
    eq(trades.brokerAccountId, accountId),
    eq(trades.status, "CLOSED"),
    eq(trades.currency, currency),
    gt(trades.totalBuyQty, "0"),
    eq(trades.totalBuyQty, trades.totalSellQty),
    gte(trades.closedAt, range.fromUtc),
    lt(trades.closedAt, range.untilUtc),
  );
  const day = sql<string>`DATE_FORMAT(DATE_ADD(${trades.closedAt}, INTERVAL 9 HOUR), '%Y-%m-%d')`;
  const [groups, recent, openOrPartialCount, executionCount] = await Promise.all([
    db
      .select({
        day,
        ruleKey: trades.ruleScope,
        ruleName: tradingRules.name,
        closedCount: sql`COUNT(*)`.mapWith(Number),
        wins: sql`SUM(CASE WHEN ${trades.realizedPnl} > 0 THEN 1 ELSE 0 END)`.mapWith(Number),
        losses: sql`SUM(CASE WHEN ${trades.realizedPnl} < 0 THEN 1 ELSE 0 END)`.mapWith(Number),
        realizedPnl: sql`SUM(${trades.realizedPnl})`.mapWith(Number),
        holdingSeconds: sql`SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, ${trades.openedAt}, ${trades.closedAt})))`.mapWith(
          Number,
        ),
      })
      .from(trades)
      .leftJoin(
        tradingRules,
        and(
          eq(tradingRules.brokerAccountId, trades.brokerAccountId),
          eq(tradingRules.ruleKey, trades.ruleScope),
        ),
      )
      .where(closed)
      .groupBy(day, trades.ruleScope, tradingRules.name),
    db
      .select({
        id: trades.id,
        name: instruments.displayName,
        ticker: instruments.symbol,
        realizedPnl: trades.realizedPnl,
        realizedReturn: trades.realizedReturnPct,
        closedAt: trades.closedAt,
      })
      .from(trades)
      .leftJoin(instruments, eq(instruments.id, trades.instrumentId))
      .where(closed)
      .orderBy(desc(trades.closedAt), desc(trades.id))
      .limit(20),
    db
      .select({ n: sql`COUNT(*)`.mapWith(Number) })
      .from(trades)
      .where(
        and(
          eq(trades.brokerAccountId, accountId),
          eq(trades.currency, currency),
          gte(trades.openedAt, range.fromUtc),
          lt(trades.openedAt, range.untilUtc),
        ),
      ),
    db
      .select({ n: sql`COUNT(*)`.mapWith(Number) })
      .from(executions)
      .where(
        and(
          eq(executions.brokerAccountId, accountId),
          gte(executions.executedAt, range.fromUtc),
          lt(executions.executedAt, range.untilUtc),
        ),
      ),
  ]);

  const summary = summarizeClosedTrades(groups);
  return {
    range,
    recent,
    ...summary,
    /** Fills may exist even when no CLOSED round-trip trades. */
    hasAnyTradesInPeriod: (openOrPartialCount[0]?.n ?? 0) > 0,
    hasAnyExecutionsInPeriod: (executionCount[0]?.n ?? 0) > 0,
  };
}
