import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { SEOUL_REGULAR_SESSION_MS, SEOUL_WEEKEND_MS } from "@/lib/market-hours";
import { setNowMs, nowMs } from "@/src/clock";
import { QuantEngine } from "@/src/engine/QuantEngine";
import { blankRule, type UserRule } from "@/src/rules/params";
import { setRuleConfigForTest, syncAllocationsToRules } from "@/src/rules/config";
import { emptyStartupSync } from "@/src/runtime/startup-sync";
import {
  LONG_SOAK_RULE_ID,
  LONG_SOAK_TICKER,
  ORDER_ELIGIBLE_FRESH_MS,
  activationGateVerdict,
  enabledAutoRules,
  evaluateRuntimeHealth,
  isOrderEligibleFresh,
  unexpectedEnabledRules,
  workerRuntimeHealthy,
  workerRuntimeStatus,
} from "@/src/runtime/paper-long-soak-health";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "paper",
  ALLOW_LIVE_TRADING: "false",
  PERSISTENCE_MODE: "mirror",
  DATABASE_URL: "mysql://app:x@127.0.0.1:3306/auto_trading",
} as const;

const KODEX_ID = "23cd18d6-5dd3-426b-baf1-4e00a2dfeafc";

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => {
  setNowMs(null);
  setRuleConfigForTest(null);
});
afterEach(() => {
  setRuleConfigForTest(null);
  for (const key of Object.keys(PAPER_ENV)) delete process.env[key];
  delete process.env.KIS_LIVE_CONFIRM;
});

function applyPaperEnv() {
  for (const [k, v] of Object.entries(PAPER_ENV)) process.env[k] = v;
}

function soakRule(extra: Partial<UserRule> = {}): UserRule {
  return blankRule({
    id: LONG_SOAK_RULE_ID,
    name: "PAPER Long Soak MA",
    ticker: LONG_SOAK_TICKER,
    kind: "ma-cross",
    fastMa: 5,
    slowMa: 20,
    buyPct: 0.05,
    sliceKrw: 300_000,
    minAmountKrw: 10_000,
    stopLossPct: 0.03,
    takeProfitPct: 0.03,
    enabled: true,
    budget: 800_000,
    ...extra,
  });
}

function kodexRule(extra: Partial<UserRule> = {}): UserRule {
  return blankRule({
    id: KODEX_ID,
    name: "안정형 · KODEX 200 적립",
    ticker: "069500",
    kind: "interval",
    intervalMs: 45_000,
    enabled: false,
    budget: 7_000_000,
    sliceKrw: 150_000,
    ...extra,
  });
}

function healthyState(opts: {
  rules?: UserRule[];
  now?: number;
  quoteAgeMs?: number;
  quoteSource?: "kis" | "mock" | "seed";
  marketOpenNow?: boolean;
  runtimeWorker?: string | null;
  autoTrading?: boolean;
  matched?: boolean;
  orderable?: number | null;
} = {}) {
  const now = opts.now ?? nowMs();
  if (opts.marketOpenNow === false) {
    // Sunday-ish closed: use a known closed Seoul instant (Saturday evening UTC-ish).
    // SEOUL_REGULAR_SESSION_MS is open; subtract to a closed window via clock override in caller.
  }
  const rules = opts.rules ?? [soakRule({ enabled: true }), kodexRule({ enabled: false })];
  setRuleConfigForTest({ rules });
  let state = syncAllocationsToRules(createPaperState(), rules);
  state.settings = { ...state.settings, autoTrading: opts.autoTrading ?? true, disclaimerAccepted: true };
  state.startupSync = { ...emptyStartupSync(), status: "HEALTHY", lastSyncedAt: new Date(now).toISOString() };
  state.safety = {
    ...state.safety,
    kind: "ok",
    tradingAllowed: true,
    persistable: true,
    workerHealthy: true,
    brokerConnected: true,
    quoteOk: true,
    reconciliation: "synced",
    closedByStop: {},
    blockedBuys: [],
  };
  const hist = Array.from({ length: 25 }, (_, i) => 30_000 + i * 10);
  const age = opts.quoteAgeMs ?? 1_000;
  // LIVE_TEST isolation: only KIS quotes may remain on the book for health PASS.
  state.quotes = {
    [LONG_SOAK_TICKER]: {
      code: LONG_SOAK_TICKER,
      name: "카카오",
      market: "KOSDAQ",
      price: 33_250,
      prevClose: 33_000,
      open: 33_000,
      high: 33_500,
      low: 32_800,
      volume: 1,
      bid: 33_250,
      ask: 33_250,
      history: hist,
      source: opts.quoteSource ?? "kis",
      freshAt: now - age,
    },
  };
  state.kisBalance = {
    syncedAt: new Date(now).toISOString(),
    fetchedAt: String(now),
    cash: 9_000_000,
    d2Cash: 9_000_000,
    orderableCash: opts.orderable === undefined ? 9_000_000 : opts.orderable,
    holdings: [
      { ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 250_000 },
      { ticker: "069500", name: "KODEX 200", qty: 1, avgPrice: 100_000 },
    ],
    cashDelta: 0,
    matched: opts.matched ?? true,
    message: "ok",
    freshness: "fresh",
  };
  state.positions = [
    { code: "005930", name: "삼성전자", qty: 1, avgPrice: 250_000, ruleId: "cash" },
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 100_000, ruleId: KODEX_ID },
  ];
  const soakAlloc = state.allocations.find((row) => row.ruleId === LONG_SOAK_RULE_ID);
  if (soakAlloc) {
    soakAlloc.meta = { maRel: "below", regime: "flat" };
  }
  return { state, now, rules, runtimeWorker: opts.runtimeWorker ?? "healthy" };
}

test("Test A: 069500 enabled=false → QuantEngine skips interval rule (no BUY)", async () => {
  applyPaperEnv();
  setNowMs(SEOUL_REGULAR_SESSION_MS);
  const rules = [soakRule({ enabled: true }), kodexRule({ enabled: false })];
  setRuleConfigForTest({ rules });
  let state = syncAllocationsToRules(createPaperState(), rules);
  state.settings = { ...state.settings, autoTrading: true, disclaimerAccepted: true };
  state.quotes["069500"] = {
    code: "069500",
    name: "KODEX 200",
    market: "KOSPI",
    price: 50_000,
    prevClose: 50_000,
    open: 50_000,
    high: 50_000,
    low: 50_000,
    volume: 1,
    bid: 50_000,
    ask: 50_000,
    history: [],
    source: "mock",
    freshAt: nowMs(),
  };
  // Force interval due: lastRunAt far past
  state.allocations = state.allocations.map((row) =>
    row.ruleId === KODEX_ID ? { ...row, lastRunAt: new Date(0).toISOString(), enabled: false } : row,
  );
  assert.equal(unexpectedEnabledRules(rules).length, 0);
  const beforeOrders = state.orders.length;
  const after = await QuantEngine.run(state);
  assert.equal(after.orders.length, beforeOrders);
  // Disabled kodex never runs — no interval message on that alloc
  const kodexAlloc = after.allocations.find((row) => row.ruleId === KODEX_ID);
  assert.ok(kodexAlloc);
  assert.equal(kodexAlloc.enabled, false);
});

test("Test B: 035720 enabled=true → Long Soak remains in enabled auto rules", () => {
  const rules = [soakRule({ enabled: true }), kodexRule({ enabled: false })];
  setRuleConfigForTest({ rules });
  const enabled = enabledAutoRules(rules);
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0]?.id, LONG_SOAK_RULE_ID);
  assert.equal(enabled[0]?.enabled, true);
});

test("Test C: only expected Long Soak rule enabled → isolated soak PASS", () => {
  applyPaperEnv();
  const { state, runtimeWorker } = healthyState();
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker,
    env: PAPER_ENV,
    includeLockProbe: false,
  });
  assert.equal(report.isolationOk, true);
  assert.equal(report.otherEnabledAutoRules.length, 0);
  assert.equal(report.kodexIntervalDisabled, true);
  assert.equal(report.kodexAllocDisabled, true);
});

test("Test D: worker status undefined → worker PASS 금지", () => {
  assert.equal(workerRuntimeHealthy(undefined), false);
  assert.equal(workerRuntimeHealthy(null), false);
  assert.equal(workerRuntimeStatus(undefined), "unknown");
  applyPaperEnv();
  const { state } = healthyState({ runtimeWorker: undefined });
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker: undefined,
    env: PAPER_ENV,
    includeLockProbe: false,
  });
  assert.equal(report.workerRuntimeOk, false);
  assert.equal(report.runtimeHealthReady, false);
  assert.match(report.reason, /WORKER_RUNTIME_UNKNOWN/);
});

test("Test E: worker unhealthy → runtime health BLOCK", () => {
  applyPaperEnv();
  const { state } = healthyState();
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker: "unhealthy",
    env: PAPER_ENV,
    includeLockProbe: false,
  });
  assert.equal(report.workerRuntime, "unhealthy");
  assert.equal(report.workerRuntimeOk, false);
  assert.equal(report.runtimeHealthReady, false);
  assert.match(report.reason, /WORKER_RUNTIME_UNHEALTHY/);
});

test("Test F: activation gate with already enabled rule → ALREADY_ENABLED not FAIL", () => {
  const verdict = activationGateVerdict({
    ruleExists: true,
    ruleEnabled: true,
    prerequisitesOk: true,
  });
  assert.equal(verdict, "ALREADY_ENABLED");
  const blocked = activationGateVerdict({
    ruleExists: true,
    ruleEnabled: false,
    prerequisitesOk: false,
  });
  assert.equal(blocked, "BLOCKED");
  const ready = activationGateVerdict({
    ruleExists: true,
    ruleEnabled: false,
    prerequisitesOk: true,
  });
  assert.equal(ready, "READY");
});

test("Test G: runtime health with enabled rule → normal health evaluation", () => {
  applyPaperEnv();
  const { state, runtimeWorker } = healthyState({ runtimeWorker: "healthy" });
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker,
    env: PAPER_ENV,
    includeLockProbe: false,
  });
  assert.equal(report.longSoakEnabled, true);
  assert.equal(report.runtimeHealthReady, true);
  assert.equal(report.maRel, "below");
});

test("Test H: market closed → Runtime Health can be READY, Order Eligible = NO", () => {
  applyPaperEnv();
  // Closed session: shared weekend fixture.
  const closedMs = SEOUL_WEEKEND_MS;
  setNowMs(closedMs);
  const { state, runtimeWorker } = healthyState({
    now: closedMs,
    quoteAgeMs: 200_000, // stale after hours is OK for READY
  });
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker,
    env: PAPER_ENV,
    now: closedMs,
    includeLockProbe: false,
  });
  assert.equal(report.marketOpen, false);
  assert.equal(report.runtimeHealthReady, true);
  assert.equal(report.orderEligibleNow, false);
  assert.equal(report.reason, "MARKET CLOSED");
  setNowMs(SEOUL_REGULAR_SESSION_MS);
});

test("Test I: quote age 16s → order eligible false", () => {
  applyPaperEnv();
  const now = nowMs();
  const { state, runtimeWorker } = healthyState({ now, quoteAgeMs: 16_000 });
  const q = state.quotes[LONG_SOAK_TICKER];
  assert.equal(isOrderEligibleFresh(q, now, ORDER_ELIGIBLE_FRESH_MS), false);
  const report = evaluateRuntimeHealth(state, {
    runtimeWorker,
    env: PAPER_ENV,
    now,
    includeLockProbe: false,
  });
  assert.equal(report.orderEligibleFresh, false);
  // Health observation window is 120s — 16s still READY during open session
  assert.equal(report.healthFresh, true);
  assert.equal(report.runtimeHealthReady, true);
  assert.equal(report.orderEligibleNow, false);
});

test("Test J: quote source mock/seed → runtime BLOCK", () => {
  applyPaperEnv();
  for (const source of ["mock", "seed"] as const) {
    const { state, runtimeWorker } = healthyState({ quoteSource: source });
    const report = evaluateRuntimeHealth(state, {
      runtimeWorker,
      env: PAPER_ENV,
      includeLockProbe: false,
    });
    assert.equal(report.runtimeHealthReady, false, source);
    assert.match(report.reason, /MOCK_SEED_QUOTE|QUOTE_SOURCE/);
  }
});
