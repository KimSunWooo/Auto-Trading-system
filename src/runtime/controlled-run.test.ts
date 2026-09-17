import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { resetRecoverableHalt } from "@/src/runtime/recovery";
import { safetyBlocksTrading } from "@/src/runtime/safety";
import {
  duplicateExecutionDetected,
  emptyControlledRun,
  formatStartSummary,
  intervalIgnoresPosition,
  isRecoverableInquiryHalt,
  padTicker,
  preTradeGate,
  selectConservativeStrategy,
  sessionBrokerSubmitCount,
} from "@/src/runtime/controlled-run";
import { checkPaperOrderConstraints, testRunBuyCount } from "@/src/risk/order-policy";
import { blankRule } from "@/src/rules/params";

test("empty strategy-config selects none without inventing a rule", () => {
  const state = createPaperState();
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 253500, ruleId: "cash" }];
  const selected = selectConservativeStrategy([], state.positions);
  assert.equal(selected.strategy, "none");
  assert.equal(selected.parametersChanged, false);
  assert.deepEqual(selected.symbols, ["005930"]);
  assert.match(selected.reason, /활성화된 UserRule 이 없다/);
  assert.equal(intervalIgnoresPosition("interval"), true);
  assert.equal(intervalIgnoresPosition("ma-cross"), false);
});

test("ma-cross is preferred over interval when both are already enabled", () => {
  const selected = selectConservativeStrategy(
    [
      blankRule({ id: "a", name: "interval", ticker: "069500", kind: "interval", buyPct: 0.05, enabled: true }),
      blankRule({
        id: "b",
        name: "ma",
        ticker: "005930",
        kind: "ma-cross",
        buyPct: 0.35,
        enabled: true,
      }),
    ],
    [],
  );
  assert.equal(selected.strategy, "ma");
  assert.equal(selected.parametersChanged, false);
});

test("soak session buy count ignores the existing VTS-B2 BUY", () => {
  const state = createPaperState();
  state.controlledRun = emptyControlledRun({
    startedAt: "2026-09-17T06:00:00.000Z",
    strategyName: "none",
    symbols: ["005930"],
  });
  state.orders = [
    {
      id: "old",
      createdAt: "2026-09-17T03:20:02.727Z",
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      amount: 253500,
      commission: 38,
      tax: 0,
      net: 253538,
      status: "filled",
      brokerOrderNo: "0000022105",
    },
  ];
  assert.equal(testRunBuyCount(state), 1);
  assert.equal(testRunBuyCount(state, state.controlledRun.startedAt), 0);
  const paper = checkPaperOrderConstraints({ qty: 1, ticker: "005930", state });
  assert.equal(paper.ok, true);
  assert.equal(sessionBrokerSubmitCount(state), 0);
});

test("timeout hard circuit is recoverable when no UNKNOWN order remains", () => {
  const state = createPaperState();
  state.circuit = {
    halted: true,
    kind: "hard",
    reason: "The operation was aborted due to timeout",
    unknownCount: 1,
    openedAt: "2026-09-17T04:57:05.044Z",
  };
  assert.equal(isRecoverableInquiryHalt(state), true);
  const reset = resetRecoverableHalt(state);
  assert.equal(reset.circuit.halted, false);
});

test("kill and soak-stop circuits are not auto-recovered", () => {
  const state = createPaperState();
  state.circuit = { halted: true, kind: "kill", reason: "긴급 정지", unknownCount: 0 };
  assert.equal(isRecoverableInquiryHalt(state), false);
  state.circuit = { halted: true, kind: "soak-stop", reason: "Duplicate execution", unknownCount: 0 };
  assert.equal(isRecoverableInquiryHalt(state), false);
});

test("mismatch reconciliation blocks live-like orders", () => {
  const state = createPaperState();
  state.safety = {
    ...state.safety!,
    reconciliation: "mismatch",
    tradingAllowed: true,
    kind: "ok",
  };
  process.env.TRADING_MODE = "live_test";
  try {
    assert.match(safetyBlocksTrading(state) ?? "", /대조|막았습니다/);
  } finally {
    delete process.env.TRADING_MODE;
  }
});

test("pre-trade gate rejects mock/seed quotes during a controlled run", () => {
  const state = createPaperState();
  state.controlledRun = emptyControlledRun({ strategyName: "none", symbols: ["005930"] });
  const quote = state.quotes["005930"]!;
  quote.source = "mock";
  quote.freshAt = Date.now();
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  process.env.KIS_MODE = "demo";
  process.env.PERSISTENCE_MODE = "mirror";
  process.env.ALLOW_LIVE_TRADING = "false";
  process.env.KIS_PAPER_APP_KEY = "paper-key";
  process.env.KIS_PAPER_APP_SECRET = "paper-secret";
  process.env.KIS_PAPER_ACCOUNT_NO = "11111111-01";
  try {
    const gate = preTradeGate(state, { side: "buy", ticker: "005930", qty: 1 });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.match(gate.blocked, /quote|Mock|unhealthy|PAPER|KIS_MODE|semantics|lock|RDS|mirror/i);
  } finally {
    delete process.env.TRADING_MODE;
    delete process.env.BROKER;
    delete process.env.KIS_MODE;
    delete process.env.PERSISTENCE_MODE;
    delete process.env.ALLOW_LIVE_TRADING;
    delete process.env.KIS_PAPER_APP_KEY;
    delete process.env.KIS_PAPER_APP_SECRET;
    delete process.env.KIS_PAPER_ACCOUNT_NO;
  }
});

test("duplicate child fills with the same ODNO are detected", () => {
  const state = createPaperState();
  state.orders = [
    {
      id: "parent",
      createdAt: "2026-09-17T03:20:02.727Z",
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      amount: 253500,
      commission: 38,
      tax: 0,
      net: 253538,
      status: "filled",
      brokerOrderNo: "0000022105",
    },
    {
      id: "child-a",
      parentOrderId: "parent",
      createdAt: "2026-09-17T03:20:02.727Z",
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      amount: 253500,
      commission: 38,
      tax: 0,
      net: 253538,
      status: "filled",
      brokerOrderNo: "0000022105",
      filledQty: 1,
    },
    {
      id: "child-b",
      parentOrderId: "parent",
      createdAt: "2026-09-17T03:20:03.000Z",
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253500,
      amount: 253500,
      commission: 38,
      tax: 0,
      net: 253538,
      status: "filled",
      brokerOrderNo: "0000022105",
      filledQty: 1,
    },
  ];
  assert.equal(duplicateExecutionDetected(state), true);
});

test("start summary Ready NO includes the reason", () => {
  const text = formatStartSummary({
    ready: false,
    readyReason: "RDS not connected",
    strategy: {
      strategy: "none",
      symbols: ["005930"],
      reason: "empty",
      parametersChanged: false,
      enabledCount: 0,
    },
    positions: ["005930 삼성전자 qty=1"],
    recon: "UNKNOWN",
    rds: "DISCONNECTED",
  });
  assert.match(text, /Domestic PAPER Controlled Run/);
  assert.match(text, /Ready:\nNO \(RDS not connected\)/);
  assert.equal(padTicker("5930"), "005930");
});
