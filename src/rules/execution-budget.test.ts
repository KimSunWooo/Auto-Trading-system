import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setNowMs, withNow } from "@/src/clock";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { toBucket, type AccountBucket } from "@/src/accounts/AccountBucket";
import { RuleRunner } from "@/src/rules/RuleRunner";
import { blankRule } from "@/src/rules/params";
import { setRuleConfigForTest, syncAllocationsToRules } from "@/src/rules/config";
import { FakeBroker, makeTestPaperState, makeTestQuote } from "@/src/test-support";
import { checkExecutionBudget, resolveExecutionBudget } from "@/src/rules/execution-budget";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

const RULE_ID = "interval-budget-rule";

function intervalRule(extra: Partial<ReturnType<typeof blankRule>> = {}) {
  return blankRule({
    id: RULE_ID,
    name: "안정형 · KODEX 200 적립",
    ticker: "069500",
    kind: "interval",
    intervalMs: 45_000,
    sliceKrw: 150_000,
    buyPct: 0.05,
    budget: 7_000_000,
    enabled: true,
    ...extra,
  });
}

function seededState(rule = intervalRule()) {
  let state = syncAllocationsToRules(makeTestPaperState(), [rule]);
  state = {
    ...state,
    quotes: {
      ...state.quotes,
      "069500": makeTestQuote("069500", 110_000),
    },
  };
  return state;
}

test("unset budgets resolve conservatively (not unlimited)", () => {
  const limits = resolveExecutionBudget(intervalRule());
  assert.equal(limits.maxExecutionsPerDay, 1);
  assert.equal(limits.maxDailyBuyKrw, 150_000);
  assert.ok(limits.minBuyIntervalMs >= 86_400_000);
  assert.ok(limits.maxPositionQty >= 1);
  assert.equal(limits.maxTotalExposurePct, 0.5);
});

test("45s tick × 20 with maxExecutionsPerDay=1 → at most 1 buy", async () => {
  const prevMode = process.env.TRADING_MODE;
  const prevBroker = process.env.BROKER;
  const prevKis = process.env.KIS_MODE;
  // Keep OrderManager off the live_test worker-lock path in unit tests.
  delete process.env.TRADING_MODE;
  delete process.env.BROKER;
  delete process.env.KIS_MODE;

  const rule = intervalRule({
    maxExecutionsPerDay: 1,
    minBuyIntervalMs: 1, // allow cadence; day cap is the gate
    maxPositionQty: 100,
    maxPositionKrw: 50_000_000,
    maxDailyBuyKrw: 10_000_000,
  });
  setRuleConfigForTest({ rules: [rule] });
  try {
    let state = makeTestPaperState();
    state = syncAllocationsToRules(state, [rule]);
    state = {
      ...state,
      quotes: {
        ...state.quotes,
        "069500": makeTestQuote("069500", 110_000),
      },
    };
    const box = { current: state };
    const alloc0 = box.current.allocations.find((r) => r.ruleId === RULE_ID)!;
    let bucket: AccountBucket = { ...toBucket(alloc0, box.current.positions) };
    delete bucket.lastRunAt;
    let buys = 0;
    for (let i = 0; i < 20; i += 1) {
      const t = SEOUL_REGULAR_SESSION_MS + i * 45_000;
      await withNow(t, async () => {
        const broker = new FakeBroker(box, RULE_ID);
        const beforeOrders = box.current.orders.filter((o) => !o.parentOrderId).length;
        bucket = await RuleRunner.execute(broker, bucket, rule, box.current);
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === RULE_ID
              ? {
                  ...row,
                  lastRunAt: bucket.lastRunAt,
                  lastMessage: bucket.lastMessage,
                  meta: bucket.meta,
                }
              : row,
          ),
        };
        const afterOrders = box.current.orders.filter((o) => !o.parentOrderId).length;
        if (afterOrders > beforeOrders) buys += afterOrders - beforeOrders;
      });
    }
    assert.equal(buys, 1, `msgs=${bucket.lastMessage} orders=${box.current.orders.length}`);
    assert.match(bucket.lastMessage ?? "", /일일 실행 한도|조건 평가/);
  } finally {
    setRuleConfigForTest(null);
    if (prevMode == null) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = prevMode;
    if (prevBroker == null) delete process.env.BROKER;
    else process.env.BROKER = prevBroker;
    if (prevKis == null) delete process.env.KIS_MODE;
    else process.env.KIS_MODE = prevKis;
  }
});

test("daily buy budget exceeded → 신규 BUY 0", () => {
  const rule = intervalRule({ maxDailyBuyKrw: 100_000, maxExecutionsPerDay: 10, minBuyIntervalMs: 1 });
  const state = seededState(rule);
  state.orders = [
    {
      id: "o1",
      createdAt: new Date(SEOUL_REGULAR_SESSION_MS).toISOString(),
      source: "rule",
      ruleId: RULE_ID,
      code: "069500",
      name: "KODEX 200",
      side: "buy",
      qty: 1,
      price: 110_000,
      amount: 110_000,
      commission: 0,
      tax: 0,
      net: 110_000,
      status: "filled",
      filledQty: 1,
      orderedQty: 1,
    },
  ];
  const alloc = state.allocations.find((r) => r.ruleId === RULE_ID)!;
  const blocked = checkExecutionBudget({
    state,
    rule,
    bucket: toBucket(alloc, state.positions),
    amountKrw: 150_000,
    price: 110_000,
    nowMs: SEOUL_REGULAR_SESSION_MS + 60_000,
  });
  assert.match(blocked ?? "", /일일 매수 한도/);
});

test("position cap exceeded → 신규 BUY 0", () => {
  const rule = intervalRule({ maxPositionQty: 11, maxExecutionsPerDay: 10, minBuyIntervalMs: 1 });
  const state = seededState(rule);
  state.positions = [
    {
      code: "069500",
      name: "KODEX 200",
      qty: 11,
      avgPrice: 110_000,
      ruleId: "cash",
    },
  ];
  const alloc = state.allocations.find((r) => r.ruleId === RULE_ID)!;
  const blocked = checkExecutionBudget({
    state,
    rule,
    bucket: toBucket(alloc, state.positions),
    amountKrw: 150_000,
    price: 110_000,
    nowMs: SEOUL_REGULAR_SESSION_MS,
  });
  assert.match(blocked ?? "", /포지션 수량 한도/);
});

test("동일 Intent 재처리 → broker order 1회 이하", async () => {
  const rule = intervalRule({
    maxExecutionsPerDay: 10,
    minBuyIntervalMs: 1,
    maxPositionQty: 100,
    maxDailyBuyKrw: 10_000_000,
    maxPositionKrw: 50_000_000,
  });
  setRuleConfigForTest({ rules: [rule] });
  try {
    const box = { current: seededState(rule) };
    const broker = new FakeBroker(box, RULE_ID);
    const intentId = "sig:interval:dup-test";
    const a = await broker.withIntent({ intentId, signalId: intentId }).buyMarket("069500", 150_000);
    const b = await broker.withIntent({ intentId, signalId: intentId }).buyMarket("069500", 150_000);
    assert.equal(a.ok, true);
    // second call returns existing / does not create another parent with same intent
    const parents = box.current.orders.filter((o) => !o.parentOrderId && o.intentId === intentId);
    assert.ok(parents.length <= 1);
    assert.ok(b.ok || b.reason || b.status);
  } finally {
    setRuleConfigForTest(null);
  }
});

test("evaluation cadence advances without buy when budget blocks", async () => {
  const rule = intervalRule({
    maxExecutionsPerDay: 1,
    minBuyIntervalMs: 1,
    maxPositionQty: 1,
    maxPositionKrw: 50_000,
  });
  // Already at position cap
  let state = seededState(rule);
  state.positions = [
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 110_000, ruleId: "cash" },
  ];
  const box = { current: state };
  const alloc = state.allocations.find((r) => r.ruleId === RULE_ID)!;
  let bucket = toBucket(alloc, state.positions);
  await withNow(SEOUL_REGULAR_SESSION_MS, async () => {
    bucket = await RuleRunner.execute(new FakeBroker(box, RULE_ID), bucket, rule, box.current);
  });
  assert.equal(Number(bucket.meta.lastEvaluatedAtMs), SEOUL_REGULAR_SESSION_MS);
  assert.match(bucket.lastMessage ?? "", /포지션/);
  assert.equal(
    box.current.orders.filter((o) => !o.parentOrderId).length,
    0,
  );
});
