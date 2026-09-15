import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { QuantEngine } from "@/src/engine/QuantEngine";
import { createPaperState } from "@/lib/engine";
import { blankRule } from "@/src/rules/params";
import { setRuleConfigForTest, syncAllocationsToRules } from "@/src/rules/config";
import {
  SEOUL_REGULAR_SESSION_MS,
  SEOUL_WEEKEND_MS,
} from "@/lib/market-hours";
import { setNowMs, withNow } from "@/src/clock";
import { noteRuleOutcome, RULE_THROTTLE_MS, ruleThrottleReason } from "@/src/rules/throttle";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

test("QuantEngine skips new orders outside regular session", async () => {
  const rule = blankRule({
    id: "r-offhours",
    ticker: "005930",
    kind: "interval",
    intervalMs: 1,
    sliceKrw: 150_000,
    buyPct: 0.2,
    budget: 2_000_000,
  });
  setRuleConfigForTest({ rules: [rule] });
  try {
    const seeded = syncAllocationsToRules(createPaperState(), [rule]);
    await withNow(SEOUL_WEEKEND_MS, async () => {
      const after = await QuantEngine.run(seeded);
      assert.equal(after.orders.length, 0);
      assert.match(after.allocations.find((row) => row.ruleId === "r-offhours")?.lastMessage ?? "", /정규장 아님/);
    });
  } finally {
    setRuleConfigForTest(null);
  }
});

test("QuantEngine does not fire a throttled rule", async () => {
  const rule = blankRule({
    id: "r-cool",
    ticker: "005930",
    kind: "interval",
    intervalMs: 1,
    sliceKrw: 150_000,
    buyPct: 0.2,
    budget: 2_000_000,
  });
  setRuleConfigForTest({ rules: [rule] });
  try {
    let state = syncAllocationsToRules(createPaperState(), [rule]);
    state = noteRuleOutcome(state, {
      ruleId: "r-cool",
      ticker: "005930",
      status: "rejected",
      reason: "잔액 부족",
    });
    state = noteRuleOutcome(state, {
      ruleId: "r-cool",
      ticker: "005930",
      status: "rejected",
      reason: "잔액 부족",
    });
    const alloc = state.allocations.find((row) => row.ruleId === "r-cool");
    assert.match(ruleThrottleReason(alloc, "005930") ?? "", /쿨다운/);
    const after = await QuantEngine.run(state);
    assert.equal(after.orders.length, 0);
    assert.match(after.allocations.find((row) => row.ruleId === "r-cool")?.lastMessage ?? "", /쿨다운/);
    assert.ok(Number(after.allocations.find((row) => row.ruleId === "r-cool")?.meta?.throttleUntilMs) > SEOUL_REGULAR_SESSION_MS);
    assert.ok(Number(after.allocations.find((row) => row.ruleId === "r-cool")?.meta?.throttleUntilMs) <= SEOUL_REGULAR_SESSION_MS + RULE_THROTTLE_MS);
  } finally {
    setRuleConfigForTest(null);
  }
});
