import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { BacktestRunner } from "./BacktestRunner";

test("BacktestRunner returns return, MDD and a trade count for the default split", async () => {
  const result = await BacktestRunner.run({
    years: 1,
    totalDeposit: TOTAL_DEPOSIT,
    allocations: DEFAULT_ALLOCATIONS.map((row) => ({ ...row })),
  });
  assert.equal(result.years, 1);
  assert.ok(result.equityCurve.length > 10);
  assert.equal(typeof result.metrics.totalReturnPct, "number");
  assert.ok(result.metrics.mddPct >= 0);
  assert.ok(result.metrics.trades >= 0);
  assert.ok(Number.isFinite(result.metrics.endEquity));
  assert.ok(result.metrics.endEquity > 0);
});
