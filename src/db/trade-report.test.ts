import assert from "node:assert/strict";
import test from "node:test";
import {
  reportDateRange,
  summarizeClosedTrades,
  type TradeReportGroup,
} from "./repositories/trade-report";

test("trade report period follows KST days across the UTC date boundary", () => {
  assert.deepEqual(reportDateRange(7, new Date("2026-11-10T15:00:00Z")), {
    fromUtc: "2026-11-04 15:00:00.000000",
    untilUtc: "2026-11-11 15:00:00.000000",
    fromDate: "2026-11-05",
    throughDate: "2026-11-11",
  });
});

test("trade report counts closed wins, losses and break-even without double counting groups", () => {
  const group: TradeReportGroup = {
    day: "2026-11-10",
    ruleKey: "ma",
    ruleName: "이평 전략",
    closedCount: 2,
    wins: 1,
    losses: 1,
    realizedPnl: 300,
    holdingSeconds: 7_200,
  };
  const report = summarizeClosedTrades([
    group,
    {
      ...group,
      day: "2026-11-11",
      closedCount: 1,
      wins: 1,
      losses: 0,
      realizedPnl: 700,
      holdingSeconds: 3_600,
    },
    {
      ...group,
      ruleKey: "cash",
      ruleName: null,
      closedCount: 1,
      wins: 0,
      losses: 0,
      realizedPnl: 0,
      holdingSeconds: 0,
    },
  ]);
  assert.equal(report.closedCount, 4);
  assert.equal(report.flat, 1);
  assert.equal(report.winRate, 0.5);
  assert.equal(report.averageHoldingSeconds, 2_700);
  assert.equal(report.realizedPnl, 1_000);
  assert.deepEqual(report.daily, [
    { day: "2026-11-10", pnl: 300 },
    { day: "2026-11-11", pnl: 700 },
  ]);
  assert.deepEqual(
    report.byStrategy.map(({ name, closedCount }) => [name, closedCount]),
    [
      ["이평 전략", 3],
      ["현금 버킷", 1],
    ],
  );
  assert.equal(summarizeClosedTrades([]).winRate, null);
});
