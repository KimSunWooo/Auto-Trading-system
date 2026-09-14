import assert from "node:assert/strict";
import test from "node:test";
import {
  getStrategyConfig,
  mergeStrategyConfig,
  resolveLevel1,
  resolveLevel10,
  resolveLevel5,
  saveStrategyConfig,
  setStrategyConfigForTest,
  validateStrategyConfig,
  watchedStrategyTickers,
} from "./config";
import { DEFAULT_STRATEGY_CONFIG } from "./params";
import { RiskLevel1Strategy } from "./RiskLevel1Strategy";
import { MockBroker } from "@/src/brokers/MockBroker";
import { toBucket } from "@/src/accounts/AccountBucket";
import { createInitialState } from "@/lib/engine";

test("defaults match the previous hardcoded playbooks", () => {
  const cfg = DEFAULT_STRATEGY_CONFIG;
  assert.equal(cfg.Level1_Stable.ticker, "069500");
  assert.equal(cfg.Level1_Stable.intervalMs, 45_000);
  assert.equal(cfg.Level1_Stable.sliceKrw, 150_000);
  assert.equal(cfg.Level5_Swing.fastMa, 5);
  assert.equal(cfg.Level5_Swing.slowMa, 20);
  assert.equal(cfg.Level10_Aggressive.k, 0.4);
  assert.equal(cfg.Level10_Aggressive.cooldownMs, 120_000);
  assert.deepEqual(cfg.Level10_Aggressive.universe, [
    "005930",
    "000660",
    "035720",
    "247540",
    "259960",
    "352820",
  ]);
});

test("bucket.meta overrides the shared strategy-config.json", () => {
  try {
    setStrategyConfigForTest({
      ...DEFAULT_STRATEGY_CONFIG,
      Level1_Stable: { ...DEFAULT_STRATEGY_CONFIG.Level1_Stable, ticker: "000660" },
    });
    assert.equal(resolveLevel1({}).ticker, "000660");
    assert.equal(resolveLevel1({ ticker: "005930" }).ticker, "005930");
    assert.equal(resolveLevel1({ intervalMs: 9_000 }).intervalMs, 9_000);
    assert.equal(resolveLevel5({ fastMa: 3 }).fastMa, 3);
    assert.deepEqual(resolveLevel10({ universe: "005930,035720" }).universe, ["005930", "035720"]);
  } finally {
    setStrategyConfigForTest(null);
  }
});

test("validateStrategyConfig rejects inverted moving averages", () => {
  const bad = mergeStrategyConfig({
    Level5_Swing: { ticker: "005930", fastMa: 20, slowMa: 5, buyPct: 0.35 },
  });
  assert.match(validateStrategyConfig(bad) ?? "", /이평/);
});

test("saveStrategyConfig keeps a valid patch in memory during tests", () => {
  try {
    const saved = saveStrategyConfig({
      Level1_Stable: { ticker: "069500", intervalMs: 30_000 },
    });
    assert.equal(saved.Level1_Stable.intervalMs, 30_000);
    assert.equal(getStrategyConfig().Level1_Stable.intervalMs, 30_000);
    assert.equal(getStrategyConfig().Level1_Stable.sliceKrw, 150_000);
  } finally {
    setStrategyConfigForTest(null);
  }
});

test("watchedStrategyTickers includes config universe and meta overrides", () => {
  try {
    setStrategyConfigForTest(DEFAULT_STRATEGY_CONFIG);
    const codes = watchedStrategyTickers([{ meta: { ticker: "017670" } }]);
    assert.ok(codes.includes("069500"));
    assert.ok(codes.includes("005930"));
    assert.ok(codes.includes("017670"));
  } finally {
    setStrategyConfigForTest(null);
  }
});

test("Level1 buys the meta ticker instead of the hardcoded ETF", async () => {
  const box = { current: createInitialState() };
  const alloc = box.current.allocations.find((row) => row.strategy === "Level1_Stable")!;
  const bucket = {
    ...toBucket(alloc, box.current.positions),
    lastRunAt: new Date(0).toISOString(),
    meta: { ticker: "005930", intervalMs: 1, sliceKrw: 150_000, minAmountKrw: 10_000 },
  };
  const after = await new RiskLevel1Strategy().execute(
    new MockBroker(box, "Level1_Stable"),
    bucket,
  );
  assert.match(after.lastMessage ?? "", /삼성전자|005930/);
  assert.equal(box.current.orders[0]?.code, "005930");
});
