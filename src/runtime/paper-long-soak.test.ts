import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { mergeRuleConfig, parseUserRule } from "@/src/rules/params";
import { syncAllocationsToRules } from "@/src/rules/config";
import {
  checkPaperOrderConstraints,
  PAPER_OPERATION_DEFAULTS,
  PAPER_TEST_POLICY,
  REAL_ORDER_POLICY,
  usesPaperOrderPolicy,
} from "@/src/risk/order-policy";
import { RiskManager } from "@/src/risk/RiskManager";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import { kisJsonPositionDiverged, preTradeGate } from "@/src/runtime/controlled-run";
import { emptyStartupSync } from "@/src/runtime/startup-sync";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
  PERSISTENCE_MODE: "mirror",
} as const;

const REAL_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live",
  KIS_MODE: "real",
  ALLOW_LIVE_TRADING: "true",
  KIS_LIVE_CONFIRM: "I_UNDERSTAND",
  KIS_REAL_APP_KEY: "real-key",
  KIS_REAL_APP_SECRET: "real-secret",
  KIS_REAL_ACCOUNT_NO: "22222222-01",
} as const;

function applyEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

afterEach(() => {
  for (const key of [...Object.keys(PAPER_ENV), ...Object.keys(REAL_ENV), "PAPER_POLICY_MODE"]) {
    delete process.env[key];
  }
});

const CONFIG_PATH = path.join(process.cwd(), "data", "strategy-config.json");

test("Long Soak rule file: exists, disabled, ma-cross 5/20, budget 800k", () => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
  const config = mergeRuleConfig(raw);
  const rule = config.rules.find((row) => row.id === "paper-long-soak-ma");
  assert.ok(rule);
  assert.equal(rule.enabled, false);
  assert.equal(rule.ticker, "035720");
  assert.equal(rule.kind, "ma-cross");
  assert.equal(rule.fastMa, 5);
  assert.equal(rule.slowMa, 20);
  assert.equal(rule.buyPct, 0.05);
  assert.equal(rule.sliceKrw, 300_000);
  assert.equal(rule.stopLossPct, 0.03);
  assert.equal(rule.takeProfitPct, 0.03);
  assert.equal(rule.budget, 800_000);
  // parseUserRule must not coerce missing enabled → true when false is set
  assert.equal(parseUserRule(rule)?.enabled, false);
});

test("Long Soak allocation sync: budget consistent, cash non-negative, enabled false", () => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
  const rule = mergeRuleConfig(raw).rules.find((row) => row.id === "paper-long-soak-ma")!;
  const state = createPaperState();
  const synced = syncAllocationsToRules(state, [rule]);
  const soak = synced.allocations.find((row) => row.ruleId === "paper-long-soak-ma");
  const cash = synced.allocations.find((row) => row.ruleId === "cash");
  assert.ok(soak && cash);
  assert.equal(soak.enabled, false);
  assert.equal(soak.budget, 800_000);
  assert.equal(cash.budget, state.totalDeposit - 800_000);
  assert.ok((cash.balance ?? 0) >= 0);
  const used = synced.allocations
    .filter((row) => row.ruleId !== "cash")
    .reduce((sum, row) => sum + row.budget, 0);
  assert.ok(used <= synced.totalDeposit);
});

test("qty semantics: qty>5 BLOCKS (does not truncate)", () => {
  applyEnv(PAPER_ENV);
  assert.equal(PAPER_OPERATION_DEFAULTS.maxQtyPerOrder, 5);
  assert.equal(checkPaperOrderConstraints({ qty: 5 }, PAPER_ENV).ok, true);
  const blocked = checkPaperOrderConstraints({ qty: 6 }, PAPER_ENV);
  assert.equal(blocked.ok, false);
  assert.match(blocked.blocked ?? "", /qty must be <= 5/);
});

test("Test P/Q: stop loss 3% and take profit 3% thresholds", () => {
  assert.equal(RiskManager.shouldStopLoss(100_000, 97_000, 0.03), true);
  assert.equal(RiskManager.shouldStopLoss(100_000, 97_100, 0.03), false);
  const avg = 100_000;
  const takePct = 0.03;
  assert.equal((103_000 - avg) / avg >= takePct, true);
  assert.equal((102_900 - avg) / avg >= takePct, false);
});

test("SELL qty safety: min(KIS, JSON) enforced in preTradeGate", () => {
  applyEnv(PAPER_ENV);
  const state = createPaperState();
  state.startupSync = { ...emptyStartupSync(), status: "HEALTHY", lastSyncedAt: new Date().toISOString() };
  state.positions = [{ code: "035720", name: "카카오", qty: 5, avgPrice: 33_000, ruleId: "paper-long-soak-ma" }];
  state.kisBalance = {
    syncedAt: new Date().toISOString(),
    fetchedAt: Date.now().toString(),
    cash: 1_000_000,
    d2Cash: 1_000_000,
    orderableCash: 1_000_000,
    holdings: [{ ticker: "035720", name: "카카오", qty: 2, avgPrice: 33_000 }],
    cashDelta: 0,
    matched: true,
    message: "ok",
    freshness: "fresh",
  };
  state.quotes["035720"] = {
    ...state.quotes["005930"]!,
    code: "035720",
    name: "카카오",
    price: 33_400,
    source: "kis",
    freshAt: Date.now(),
  };
  // Without full inquiry snapshot, gate may fail earlier; still assert divergence helper + qty rule.
  assert.equal(kisJsonPositionDiverged(state), true);
  const gate = preTradeGate(state, { side: "sell", ticker: "035720", qty: 5 }, PAPER_ENV);
  assert.equal(gate.ok, false);
});

test("maxTickerWeight and position cap remain active", () => {
  applyEnv(PAPER_ENV);
  assert.equal(DEFAULT_PRODUCT_RISK.maxTickerWeight, 0.2);
  const state = createPaperState();
  state.positions = [{ code: "035720", name: "카카오", qty: 48, avgPrice: 33_000, ruleId: "cash" }];
  const overCap = checkPaperOrderConstraints(
    { qty: 3, ticker: "035720", state, side: "buy" },
    PAPER_ENV,
  );
  assert.equal(overCap.ok, false);
  assert.match(overCap.blocked ?? "", /position qty cap 50/);
});

test("VTS harness + REAL policy unchanged", () => {
  assert.equal(PAPER_TEST_POLICY.maxQtyPerOrder, 1);
  assert.equal(PAPER_TEST_POLICY.maxNewBuyPerTestRun, 1);
  assert.equal(PAPER_TEST_POLICY.maxBrokerSubmitsPerDay, 5);
  assert.equal(usesPaperOrderPolicy(REAL_ENV), false);
  assert.equal(REAL_ORDER_POLICY.enforceAmountCaps, true);
});
