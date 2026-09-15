import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_RULE_CONFIG,
  blankRule,
  mergeRuleConfig,
  parseUserRule,
  validateRuleConfig,
} from "@/src/rules/params";
import {
  getRuleConfig,
  patchRuleConfig,
  saveRuleConfig,
  setRuleConfigForTest,
  syncAllocationsToRules,
} from "@/src/rules/config";
import { createInitialState, createPaperState } from "@/lib/engine";
import { RuleRunner } from "@/src/rules/RuleRunner";
import { MockBroker } from "@/src/brokers/MockBroker";
import { toBucket } from "@/src/accounts/AccountBucket";
import { QuantEngine } from "@/src/engine/QuantEngine";

test("empty user config has no tickers and no playbook ids", () => {
  assert.deepEqual(EMPTY_RULE_CONFIG, { rules: [] });
  assert.equal(getRuleConfig().rules.length, 0);
  assert.equal(mergeRuleConfig({ Level1_Stable: { ticker: "069500" } }).rules.length, 0);
});

test("parseUserRule requires a 6-digit ticker the user typed", () => {
  assert.equal(parseUserRule({ ticker: "" }), null);
  assert.equal(parseUserRule({ ticker: "069500" })?.ticker, "069500");
  const parsed = parseUserRule({
    ticker: "005930",
    kind: "ma-cross",
    fastMa: 5,
    slowMa: 20,
    buyPct: 0.1,
    sliceKrw: 100_000,
    stopLossPct: 0.05,
    takeProfitPct: 0.03,
    budget: 1_000_000,
  });
  assert.equal(parsed?.kind, "ma-cross");
  assert.equal(parsed?.id.includes("Level"), false);
});

test("validateRuleConfig rejects inverted moving averages", () => {
  const bad = mergeRuleConfig({
    rules: [blankRule({ ticker: "005930", kind: "ma-cross", fastMa: 20, slowMa: 5 })],
  });
  assert.match(validateRuleConfig(bad) ?? "", /이평/);
});

test("saveRuleConfig persists only the rules array", () => {
  try {
    const saved = saveRuleConfig({
      rules: [
        {
          ticker: "005930",
          kind: "interval",
          intervalMs: 30_000,
          buyPct: 0.1,
          sliceKrw: 80_000,
          stopLossPct: 0.05,
          takeProfitPct: 0.03,
          budget: 2_000_000,
        },
      ],
    });
    assert.equal(saved.rules.length, 1);
    assert.equal(saved.rules[0]?.ticker, "005930");
    assert.equal(saved.rules[0]?.intervalMs, 30_000);
    assert.equal(getRuleConfig().rules[0]?.ticker, "005930");
  } finally {
    setRuleConfigForTest(null);
  }
});

test("patchRuleConfig overlays a single rule onto the current file", () => {
  try {
    saveRuleConfig({
      rules: [{ id: "r1", ticker: "005930", intervalMs: 30_000, budget: 1_000_000 }],
    });
    const patched = patchRuleConfig({ id: "r1", ticker: "005930", intervalMs: 45_000, budget: 1_000_000 });
    assert.equal(patched.rules[0]?.intervalMs, 45_000);
    assert.equal(patched.rules.length, 1);
  } finally {
    setRuleConfigForTest(null);
  }
});

test("syncAllocationsToRules starts from cash-only when there are no rules", () => {
  const next = syncAllocationsToRules(createInitialState(), []);
  assert.equal(next.allocations.length, 1);
  assert.equal(next.allocations[0]?.ruleId, "cash");
  assert.equal(next.allocations[0]?.balance, 10_000_000);
});

test("RuleRunner interval buy uses the ticker from the user rule", async () => {
  try {
    const rule = blankRule({
      id: "r-interval",
      ticker: "005930",
      kind: "interval",
      intervalMs: 1,
      sliceKrw: 150_000,
      buyPct: 0.2,
      budget: 7_000_000,
    });
    setRuleConfigForTest({ rules: [rule] });
    const state = createPaperState();
    const synced = syncAllocationsToRules(state, [rule]);
    const box = { current: synced };
    const alloc = box.current.allocations.find((row) => row.ruleId === "r-interval")!;
    const after = await RuleRunner.execute(
      new MockBroker(box, "r-interval"),
      { ...toBucket(alloc, box.current.positions), lastRunAt: new Date(0).toISOString() },
      rule,
    );
    assert.match(after.lastMessage ?? "", /삼성전자|005930|조건 매수/);
    assert.equal(box.current.orders[0]?.code, "005930");
    assert.equal(box.current.orders[0]?.ruleId, "r-interval");
  } finally {
    setRuleConfigForTest(null);
  }
});

test("QuantEngine does nothing when the rule list is empty", async () => {
  setRuleConfigForTest({ rules: [] });
  try {
    const after = await QuantEngine.run(createPaperState());
    assert.equal(after.orders.length, 0);
    assert.equal(after.positions.length, 0);
  } finally {
    setRuleConfigForTest(null);
  }
});
