import assert from "node:assert/strict";
import { after, before, afterEach, test } from "node:test";
import type { Quote } from "@/lib/types";
import { FakeBroker, makeTestPaperState } from "@/src/test-support";
import { toBucket } from "@/src/accounts/AccountBucket";
import { blankRule } from "@/src/rules/params";
import { setRuleConfigForTest, syncAllocationsToRules } from "@/src/rules/config";
import { RuleRunner } from "@/src/rules/RuleRunner";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import { sma } from "@/src/strategies/indicators";

const RULE_ID = "paper-long-soak-ma";
const TICKER = "035720";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => {
  setNowMs(null);
  setRuleConfigForTest(null);
});
afterEach(() => setRuleConfigForTest(null));

function makeHistory(fastAbove: boolean): number[] {
  // 20+ bars. Last 5 high/low relative to prior 15 for slow.
  const base = Array.from({ length: 20 }, () => 30_000);
  if (fastAbove) {
    // recent closes elevated so MA5 > MA20
    for (let i = 15; i < 20; i += 1) base[i] = 40_000;
  } else {
    for (let i = 15; i < 20; i += 1) base[i] = 20_000;
  }
  return base;
}

function quoteFor(history: number[]): Quote {
  const price = history[history.length - 1]!;
  return {
    code: TICKER,
    name: "카카오",
    market: "KOSDAQ",
    price,
    prevClose: price,
    open: price,
    high: price,
    low: price,
    volume: 1,
    bid: price,
    ask: price,
    history,
    source: "mock",
    freshAt: Date.now(),
  };
}

function soakRule(extra: Partial<ReturnType<typeof blankRule>> = {}) {
  return blankRule({
    id: RULE_ID,
    name: "PAPER Long Soak MA",
    ticker: TICKER,
    kind: "ma-cross",
    fastMa: 5,
    slowMa: 20,
    buyPct: 0.05,
    sliceKrw: 300_000,
    minAmountKrw: 10_000,
    stopLossPct: 0.03,
    takeProfitPct: 0.03,
    enabled: false,
    budget: 800_000,
    ...extra,
  });
}

async function runOnce(opts: {
  history: number[];
  meta?: Record<string, string | number | boolean | null>;
  positions?: Array<{ code: string; name: string; qty: number; avgPrice: number; ruleId: string }>;
}) {
  const rule = soakRule({ enabled: true }); // execute path only; config file stays disabled
  setRuleConfigForTest({ rules: [soakRule({ enabled: false })] });
  const state = syncAllocationsToRules(makeTestPaperState(), [rule]);
  state.quotes[TICKER] = quoteFor(opts.history);
  if (opts.positions) state.positions = opts.positions;
  const box = { current: state };
  const alloc = box.current.allocations.find((row) => row.ruleId === RULE_ID)!;
  const bucket = {
    ...toBucket(alloc, box.current.positions),
    meta: { ...(alloc.meta ?? {}), ...(opts.meta ?? {}) },
  };
  const after = await RuleRunner.execute(new FakeBroker(box, RULE_ID), bucket, rule);
  return { after, box, fast: sma(opts.history, 5)!, slow: sma(opts.history, 20)! };
}

test("Test A: fast <= slow → NO BUY", async () => {
  const history = makeHistory(false);
  const { after, box, fast, slow } = await runOnce({ history, meta: { maRel: "above", regime: "flat" } });
  assert.ok(fast <= slow);
  assert.equal(box.current.orders.length, 0);
  assert.match(after.lastMessage ?? "", /대기|하향|워밍업|시세/);
});

test("Test B: true crossover (below→above) + flat regime → BUY signal path", async () => {
  const history = makeHistory(true);
  const { after, box, fast, slow } = await runOnce({
    history,
    meta: { maRel: "below", regime: "flat" },
  });
  assert.ok(fast > slow);
  assert.equal(box.current.orders.length, 1);
  assert.equal(box.current.orders[0]?.side, "buy");
  assert.equal(box.current.orders[0]?.code, TICKER);
  assert.match(after.lastMessage ?? "", /상향|매수|접수/);
  assert.equal(after.meta.maRel, "above");
});

test("Test B2: fast > slow without prior below (missing maRel) → NO BUY (restart-safe)", async () => {
  const history = makeHistory(true);
  const { box, fast, slow } = await runOnce({ history, meta: { regime: "flat" } });
  assert.ok(fast > slow);
  assert.equal(box.current.orders.length, 0);
});

test("Case A restart: fast > slow + regime long → NEW BUY = 0", async () => {
  const history = makeHistory(true);
  const { box } = await runOnce({
    history,
    meta: { maRel: "above", regime: "long" },
  });
  assert.equal(box.current.orders.length, 0);
});

test("Case C next-day existing trend: maRel lost + fast>slow → NO BUY (FALSE ENTRY mitigated)", async () => {
  const history = makeHistory(true);
  const { box } = await runOnce({
    history,
    meta: { regime: "flat" }, // maRel missing after partial state loss
  });
  assert.equal(box.current.orders.length, 0);
});

test("Case C with maRel above persisted: still NO BUY", async () => {
  const history = makeHistory(true);
  const { box } = await runOnce({
    history,
    meta: { maRel: "above", regime: "flat" },
  });
  assert.equal(box.current.orders.length, 0);
});

test("Test O: fast < slow + regime long + held → SELL signal", async () => {
  const history = makeHistory(false);
  const { after, box, fast, slow } = await runOnce({
    history,
    meta: { maRel: "above", regime: "long" },
    positions: [{ code: TICKER, name: "카카오", qty: 2, avgPrice: 33_000, ruleId: RULE_ID }],
  });
  assert.ok(fast < slow);
  assert.equal(box.current.orders[0]?.side, "sell");
  assert.match(after.lastMessage ?? "", /하향|매도/);
});

test("Idle path persists maRel without ordering", async () => {
  const history = makeHistory(true);
  const { after, box } = await runOnce({
    history,
    meta: { maRel: "above", regime: "flat" },
  });
  assert.equal(box.current.orders.length, 0);
  assert.equal(after.meta.maRel, "above");
});

test("Long Soak rule file semantics: enabled stays false in config helper", () => {
  const rule = soakRule({ enabled: false });
  assert.equal(rule.enabled, false);
  assert.equal(rule.ticker, TICKER);
  assert.equal(rule.fastMa, 5);
  assert.equal(rule.slowMa, 20);
  assert.equal(rule.budget, 800_000);
  assert.equal(rule.stopLossPct, 0.03);
  assert.equal(rule.takeProfitPct, 0.03);
});
