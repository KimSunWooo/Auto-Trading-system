/**
 * Circuit / transient KIS query failure tests (C1–C9 core).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { tradingBlocked } from "@/src/risk/circuit";
import { CONSECUTIVE_INQUIRY_FAIL_LIMIT, emptyControlledRun, noteInquiry } from "@/src/runtime/controlled-run";
import { markInquiryFailure, resetRecoverableHalt } from "@/src/runtime/recovery";
import { clearSafetyBlock } from "@/src/runtime/safety";
import {
  classifyKisQueryError,
  resetKisQueryTelemetryForTest,
} from "@/src/runtime/kis-query-telemetry";
import { enabledRuleTickers, watchedRuleTickers } from "@/src/rules/params";
import { setRuleConfigForTest } from "@/src/rules/config";
import { blankRule } from "@/src/rules/params";
import { watchedTickersFrom } from "@/src/rules/config";

afterEach(() => {
  setRuleConfigForTest(null);
  resetKisQueryTelemetryForTest();
});

test("C1: single critical quote failure → NO ORDER, circuit.halted=false", () => {
  let state = createPaperState();
  state = markInquiryFailure(
    state,
    "data",
    "The operation was aborted due to timeout",
  );
  assert.equal(state.safety?.kind, "market_data_unavailable");
  assert.equal(state.safety?.tradingAllowed, false);
  assert.equal(state.circuit?.halted, false);
  assert.match(tradingBlocked(state) ?? "", /시세|막았|timeout|조회/i);
});

test("C2: next healthy tick clears transient safety", () => {
  let state = createPaperState();
  state = markInquiryFailure(state, "data", "timeout aborted");
  assert.ok(tradingBlocked(state));
  state = clearSafetyBlock(resetRecoverableHalt(state), {
    quoteOk: true,
    brokerConnected: true,
    reconciliation: "synced",
    workerHealthy: true,
  });
  assert.equal(state.safety?.kind, "ok");
  assert.equal(state.circuit?.halted, false);
  assert.equal(tradingBlocked(state), null);
});

test("C3: 3 consecutive critical failures → persistent circuit", () => {
  let state = createPaperState();
  state.controlledRun = emptyControlledRun({ strategyName: "test", symbols: ["035720"] });
  for (let i = 0; i < CONSECUTIVE_INQUIRY_FAIL_LIMIT; i += 1) {
    // Match engine order: markInquiryFailure before noteInquiry bump.
    state = markInquiryFailure(state, "data", "timeout aborted");
    state = noteInquiry(state, {
      quoteOk: false,
      balanceOk: true,
      orderableOk: true,
      positionOk: true,
      openOrdersOk: true,
      executionOk: true,
      recon: "UNKNOWN",
    });
  }
  assert.equal(state.controlledRun?.consecutiveInquiryFailures, CONSECUTIVE_INQUIRY_FAIL_LIMIT);
  assert.equal(state.circuit?.halted, true);
  assert.ok(tradingBlocked(state));
});

test("C4: UNKNOWN circuit never auto-cleared by resetRecoverableHalt", () => {
  let state = createPaperState();
  state.circuit = {
    halted: true,
    kind: "unknown",
    reason: "미확인 주문",
    unknownCount: 1,
  };
  state.orders = [
    {
      id: "u1",
      createdAt: new Date().toISOString(),
      source: "rule",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70000,
      amount: 70000,
      commission: 0,
      tax: 0,
      net: 70000,
      status: "unknown",
    },
  ];
  const reset = resetRecoverableHalt(state);
  assert.equal(reset.circuit?.halted, true);
});

test("C6/C7 classify: timeout=TRANSIENT, auth=AUTH_CONFIG", () => {
  assert.equal(classifyKisQueryError({ timeout: true }).toString(), "TRANSIENT");
  assert.equal(classifyKisQueryError({ message: "EGW00201 초당 거래건수" }), "TRANSIENT");
  assert.equal(classifyKisQueryError({ httpStatus: 401, message: "invalid token" }), "AUTH_CONFIG");
});

test("C8: disabled unused ticker excluded from execution-critical watch list", () => {
  setRuleConfigForTest({
    rules: [
      blankRule({
        id: "paper-long-soak-ma",
        ticker: "035720",
        kind: "ma-cross",
        enabled: true,
      }),
      blankRule({
        id: "kodex",
        ticker: "069500",
        kind: "interval",
        enabled: false,
      }),
    ],
  });
  const all = watchedRuleTickers({
    rules: [
      blankRule({ id: "a", ticker: "035720", enabled: true }),
      blankRule({ id: "b", ticker: "069500", enabled: false }),
    ],
  });
  assert.ok(all.includes("069500"));
  const enabled = enabledRuleTickers({
    rules: [
      blankRule({ id: "a", ticker: "035720", enabled: true }),
      blankRule({ id: "b", ticker: "069500", enabled: false }),
    ],
  });
  assert.deepEqual(enabled, ["035720"]);
  const state = createPaperState();
  state.positions = [];
  const watched = watchedTickersFrom(state);
  assert.ok(watched.includes("035720"));
  assert.equal(watched.includes("069500"), false);
});

test("C9: held position ticker remains watched even if rule disabled", () => {
  setRuleConfigForTest({
    rules: [
      blankRule({
        id: "kodex",
        ticker: "069500",
        kind: "interval",
        enabled: false,
      }),
    ],
  });
  const state = createPaperState();
  state.positions = [
    { code: "069500", name: "KODEX 200", qty: 1, avgPrice: 100000, ruleId: "kodex" },
  ];
  const watched = watchedTickersFrom(state);
  assert.ok(watched.includes("069500"));
});
