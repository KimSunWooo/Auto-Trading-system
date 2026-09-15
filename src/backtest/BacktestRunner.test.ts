import assert from "node:assert/strict";
import test from "node:test";
import { blankRule } from "@/src/rules/params";
import { setRuleConfigForTest, syncAllocationsToRules } from "@/src/rules/config";
import { createInitialState } from "@/lib/engine";
import { BacktestRunner } from "./BacktestRunner";

test("BacktestRunner returns empty metrics when the user has no rules", async () => {
  setRuleConfigForTest({ rules: [] });
  try {
    const result = await BacktestRunner.run({
      years: 1,
      totalDeposit: 10_000_000,
      allocations: [{ ruleId: "cash", budget: 10_000_000, balance: 10_000_000, enabled: true }],
    });
    assert.equal(result.years, 1);
    assert.equal(result.ruleIds.length, 0);
    assert.equal(result.metrics.trades, 0);
    assert.equal(result.metrics.endEquity, 10_000_000);
  } finally {
    setRuleConfigForTest(null);
  }
});

test("BacktestRunner replays a user interval rule on synthetic candles", async () => {
  const rule = blankRule({
    id: "bt-1",
    ticker: "005930",
    kind: "interval",
    intervalMs: 1,
    sliceKrw: 150_000,
    buyPct: 0.2,
    budget: 5_000_000,
    stopLossPct: 0.05,
    takeProfitPct: 0.5,
  });
  setRuleConfigForTest({ rules: [rule] });
  try {
    const seeded = syncAllocationsToRules({ ...createInitialState(), totalDeposit: 10_000_000 }, [rule]);
    const result = await BacktestRunner.run({
      years: 1,
      totalDeposit: 10_000_000,
      allocations: seeded.allocations,
    });
    assert.equal(result.years, 1);
    assert.ok(result.equityCurve.length > 10);
    assert.equal(typeof result.metrics.totalReturnPct, "number");
    assert.ok(result.metrics.mddPct >= 0);
    assert.ok(Number.isFinite(result.metrics.endEquity));
    assert.ok(result.metrics.endEquity > 0);
  } finally {
    setRuleConfigForTest(null);
  }
});
