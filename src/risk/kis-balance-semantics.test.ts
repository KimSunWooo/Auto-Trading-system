import assert from "node:assert/strict";
import test from "node:test";
import { createPaperState } from "@/lib/engine";
import { feeBreakdown } from "@/src/accounts/fills";
import {
  engineReconciliationFlag,
  intentStatusFromOrder,
  isBrokerSnapshotStale,
  reconProjectionFromState,
  shouldSkipReconPersist,
  usesPaperBrokerBalanceSemantics,
} from "@/src/risk/kis-balance-semantics";
import { diffLocalVsKis } from "@/src/risk/balance-sync";
import { CASH_RULE_ID } from "@/src/rules/params";
import type { Order } from "@/lib/types";

const PAPER = { BROKER: "kis", KIS_MODE: "paper" };
const REAL = {
  BROKER: "kis",
  KIS_MODE: "real",
  TRADING_MODE: "live",
  ALLOW_LIVE_TRADING: "true",
  KIS_LIVE_CONFIRM: "I_UNDERSTAND",
};

test("PAPER semantics require explicit BROKER=kis and KIS_MODE=paper|demo", () => {
  assert.equal(usesPaperBrokerBalanceSemantics({ BROKER: "kis", KIS_MODE: "paper" }), true);
  assert.equal(usesPaperBrokerBalanceSemantics({ BROKER: "kis", KIS_MODE: "demo" }), true);
  assert.equal(usesPaperBrokerBalanceSemantics({ BROKER: "kis", KIS_MODE: "" }), false);
  assert.equal(usesPaperBrokerBalanceSemantics({ BROKER: "mock", KIS_MODE: "paper" }), false);
  assert.equal(usesPaperBrokerBalanceSemantics(REAL), false);
  assert.equal(
    usesPaperBrokerBalanceSemantics({
      BROKER: "kis",
      KIS_MODE: "paper",
      ALLOW_LIVE_TRADING: "true",
    }),
    false,
  );
});

test("A. PAPER does not mismatch local ledger cash vs dnca_tot_amt when position matches", () => {
  const state = createPaperState();
  state.cash = 9_746_462;
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 253_500, ruleId: CASH_RULE_ID }];
  const diff = diffLocalVsKis(
    state,
    {
      cash: 10_000_000,
      d2Cash: 10_000_000,
      thdtBuyAmt: 253_500,
      holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253_500 }],
    },
    undefined,
    PAPER,
  );
  assert.equal(diff.cashCompared, false);
  assert.equal(diff.positionMatched, true);
  assert.equal(diff.matched, true);
  assert.equal(diff.cashDelta, 9_746_462 - 10_000_000);
});

test("REAL still treats local ledger cash vs dnca_tot_amt as a mismatch", () => {
  const state = createPaperState();
  state.cash = 9_746_462;
  state.positions = [{ code: "005930", name: "삼성전자", qty: 1, avgPrice: 253_500, ruleId: CASH_RULE_ID }];
  const diff = diffLocalVsKis(
    state,
    {
      cash: 10_000_000,
      d2Cash: 10_000_000,
      thdtBuyAmt: 253_500,
      holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253_500 }],
    },
    undefined,
    REAL,
  );
  assert.equal(diff.cashCompared, true);
  assert.equal(diff.positionMatched, true);
  assert.equal(diff.matched, false);
  assert.match(diff.reasons.join(" "), /예수금/);
});

test("local ledger fee math for 1 @ 253500 matches runtime commission policy", () => {
  const fees = feeBreakdown("buy", 253_500);
  assert.equal(fees.commission, 38);
  assert.equal(10_000_000 - 253_500 - fees.commission, 9_746_462);
});

test("C. stale matched=true snapshot is not a new HEALTHY recon", () => {
  const state = createPaperState();
  state.kisBalance = {
    syncedAt: "2026-09-17T03:00:00.000Z",
    fetchedAt: "2026-09-17T03:00:00.000Z",
    cash: 10_000_000,
    d2Cash: 10_000_000,
    holdings: [{ ticker: "005930", name: "삼성전자", qty: 1, avgPrice: 253_500 }],
    cashDelta: 0,
    matched: true,
    freshness: "fresh",
    message: "pre-order",
  };
  state.orders = [
    {
      id: "odno-fill",
      createdAt: "2026-09-17T03:20:00.000Z",
      source: "manual",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 253_500,
      amount: 253_500,
      commission: 38,
      tax: 0,
      net: 253_538,
      status: "filled",
      brokerOrderNo: "0000022105",
    },
  ];
  assert.equal(isBrokerSnapshotStale(state, state.kisBalance), true);
  const recon = reconProjectionFromState(state, PAPER);
  assert.equal(recon?.status, "UNKNOWN");
  assert.equal(
    shouldSkipReconPersist(
      { status: "HEALTHY", startedAt: "2026-09-17T03:00:00.000Z", finishedAt: "2026-09-17T03:00:00.000Z" },
      recon!,
      state.kisBalance.syncedAt,
    ),
    false,
  );
  assert.equal(
    shouldSkipReconPersist(
      { status: "HEALTHY", startedAt: "2026-09-17T03:00:00.000Z", finishedAt: "2026-09-17T03:00:00.000Z" },
      { status: "HEALTHY" },
      "2026-09-17T03:00:00.000Z",
    ),
    true,
  );
});

test("E. intent status follows linked order lifecycle", () => {
  const filled: Order = {
    id: "o1",
    createdAt: "2026-09-17T03:20:00.000Z",
    source: "manual",
    code: "005930",
    name: "삼성전자",
    side: "buy",
    qty: 1,
    price: 253_500,
    amount: 253_500,
    commission: 38,
    tax: 0,
    net: 253_538,
    status: "filled",
    brokerOrderNo: "0000022105",
    intentId: "intent-1",
  };
  assert.equal(intentStatusFromOrder(filled, "pending"), "FILLED");
  assert.equal(intentStatusFromOrder({ ...filled, status: "rejected" }, "pending"), "REJECTED");
  assert.equal(
    intentStatusFromOrder({ ...filled, status: "pending", brokerOrderNo: "0000022105" }, "pending"),
    "SUBMITTED",
  );
  assert.equal(intentStatusFromOrder(undefined, "pending"), "PENDING");
});

test("stale broker snapshot marks engine reconciliation unavailable", () => {
  const state = createPaperState();
  state.kisBalance = {
    syncedAt: "2026-09-17T03:00:00.000Z",
    cash: 10_000_000,
    d2Cash: 10_000_000,
    holdings: [],
    cashDelta: 0,
    matched: true,
    freshness: "unknown",
    message: "balance down",
  };
  assert.equal(engineReconciliationFlag(state), "unavailable");
});
