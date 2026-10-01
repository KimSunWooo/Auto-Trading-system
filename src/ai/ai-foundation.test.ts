import assert from "node:assert/strict";
import test from "node:test";
import { validateAiTradeProposalV1 } from "@/src/ai/trade-proposal-v1";
import { checkAiBuyBudget, DEFAULT_AI_BUDGET_POLICY } from "@/src/ai/budget-policy";
import { MemoryLedger } from "@/src/db/ledger";
import { reconstituteAppStateFromLedger } from "@/src/db/reconstitute-state";
import { persistTradingLedger, DatabaseLedgerError } from "@/src/db/persist";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import { createPaperState } from "@/lib/engine";
import { persistenceMode, isDatabaseLedgerAuthority } from "@/src/db/config";

test("persistenceMode accepts database", () => {
  assert.equal(persistenceMode({ PERSISTENCE_MODE: "database" }), "database");
  assert.equal(isDatabaseLedgerAuthority({ PERSISTENCE_MODE: "database" }), true);
  assert.equal(isDatabaseLedgerAuthority({ PERSISTENCE_MODE: "mirror" }), false);
});

test("database mode persist throws when ledger missing", async () => {
  setMirrorLedgerForTest(null);
  await assert.rejects(
    () => persistTradingLedger(createPaperState(), { PERSISTENCE_MODE: "database" }),
    (err: unknown) => err instanceof DatabaseLedgerError,
  );
});

test("reconstitute from MemoryLedger recovers intents/orders without JSON", async () => {
  const ledger = new MemoryLedger();
  const accountId = "acct-reconstitute-1";
  const instrumentId = "inst-005930";
  await ledger.transaction(async (tx) => {
    await tx.upsertInstrument({
      id: instrumentId,
      country: "KR",
      market: "KOSPI",
      symbol: "005930",
      displayName: "Samsung",
      currency: "KRW",
      kisExchangeCode: null,
      instrumentType: "EQUITY",
      isActive: true,
    });
    await tx.upsertBrokerAccount({
      id: accountId,
      userId: "user-1",
      broker: "KIS",
      environment: "PAPER",
      displayName: "paper",
      accountNumberMasked: "****1234",
      baseCurrency: "KRW",
      status: "ACTIVE",
      isDefault: true,
      credentialRef: null,
      physicalAccountFingerprint: "a".repeat(64),
    });
    await tx.upsertIntent({
      id: "intent-1",
      brokerAccountId: accountId,
      instrumentId,
      intentKey: "sig:manual:cash:005930:buy:1:1",
      ruleKey: "cash",
      source: "MANUAL",
      side: "BUY",
      quantity: "1.00000000",
      referencePrice: "70000.00000000",
      orderType: "MARKET",
      tradingMode: "PAPER",
      status: "PENDING",
      reason: "test",
      createdAt: "2026-01-01 00:00:00.000000",
      updatedAt: "2026-01-01 00:00:00.000000",
      completedAt: null,
    });
    await tx.upsertOrder({
      id: "order-row-1",
      brokerAccountId: accountId,
      instrumentId,
      intentId: "intent-1",
      localOrderId: "local-order-1",
      brokerOrderNo: "ODNO1",
      brokerOrderDate: "20260101",
      brokerOrgNo: null,
      side: "BUY",
      orderType: "MARKET",
      requestedQty: "1.00000000",
      requestedPrice: "70000.00000000",
      filledQty: "0.00000000",
      remainingQty: "1.00000000",
      averageFillPrice: null,
      currency: "KRW",
      status: "PENDING",
      source: "MANUAL",
      sourceId: null,
      ruleKey: "cash",
      reason: null,
      brokerCode: null,
      brokerMessage: null,
      submittedAt: "2026-01-01 00:00:00.000000",
      acceptedAt: null,
      completedAt: null,
      createdAt: "2026-01-01 00:00:00.000000",
      updatedAt: "2026-01-01 00:00:00.000000",
    });
  });

  const state = await reconstituteAppStateFromLedger(ledger, accountId);
  assert.equal(state.intents?.length, 1);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0]?.brokerOrderNo, "ODNO1");
  assert.equal(state.orders[0]?.code, "005930");
});

test("AI v1 proposal validates but is never order-eligible", () => {
  const now = Date.parse("2026-06-01T01:00:00.000Z");
  const ok = validateAiTradeProposalV1(
    {
      proposalId: "p1",
      schemaVersion: "ai.trade-proposal.v1",
      dataMode: "LIVE_SHADOW",
      generatedAt: "2026-06-01T00:50:00.000Z",
      analysisAsOf: "2026-06-01T00:40:00.000Z",
      validUntil: "2026-06-01T02:00:00.000Z",
      modelVersion: "m1",
      featureVersion: "f1",
      policyVersion: "pol1",
      market: "KR",
      ticker: "005930",
      action: "BUY",
      isOrder: false,
    },
    { nowMs: now },
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.orderEligible, false);

  const hold = validateAiTradeProposalV1(
    {
      proposalId: "p2",
      schemaVersion: "ai.trade-proposal.v1",
      dataMode: "LIVE_OBSERVATION",
      generatedAt: "2026-06-01T00:50:00.000Z",
      analysisAsOf: "2026-06-01T00:40:00.000Z",
      validUntil: "2026-06-01T02:00:00.000Z",
      modelVersion: "m1",
      featureVersion: "f1",
      policyVersion: "pol1",
      market: "KR",
      ticker: "005930",
      action: "HOLD",
    },
    { nowMs: now },
  );
  assert.equal(hold.ok, false);
});

test("AI budget absolute cap is 1.10×A not per-order", () => {
  const policy = {
    ...DEFAULT_AI_BUDGET_POLICY,
    allocationKrw: 1_000_000,
    allowTenPercentOverdraft: true,
    autoOrderEnabled: true,
    haltNewAiOrders: false,
  };
  const first = checkAiBuyBudget({
    policy,
    usage: { positionCostKrw: 0, reservedBuyKrw: 0 },
    orderNotionalKrw: 1_050_000,
    unallocatedCashKrw: 200_000,
    kisOrderableCashKrw: 2_000_000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.absoluteCapKrw, 1_100_000);

  const over = checkAiBuyBudget({
    policy,
    usage: { positionCostKrw: 1_050_000, reservedBuyKrw: 0 },
    orderNotionalKrw: 100_000,
    unallocatedCashKrw: 200_000,
    kisOrderableCashKrw: 2_000_000,
  });
  assert.equal(over.ok, false);
});
