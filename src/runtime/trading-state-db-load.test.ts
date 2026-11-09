/**
 * PERSISTENCE_MODE=database: DB book wins over stale JSON cache on load.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { MemoryLedger } from "@/src/db/ledger";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import { instrumentIdFor } from "@/src/db/mapping";
import { money } from "@/src/db/money";
import { stableId } from "@/src/db/ids";
import { createTradingStateStore } from "@/src/runtime/trading-state-store";

const ACCOUNT_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MASTER = "test-broker-credential-master-key-32chars!!";

before(() => {
  process.env.PERSISTENCE_MODE = "database";
  process.env.DATABASE_URL = process.env.DATABASE_URL || "mysql://test:test@127.0.0.1:3306/test";
  process.env.BROKER_CREDENTIAL_MASTER_KEY = MASTER;
  process.env.PAPER_RUNTIME_OWNER = "accounts";
});

after(() => {
  setMirrorLedgerForTest(null);
});

test("stale JSON orders do not overwrite newer DB orders on load", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "db-load-"));
  const statePath = path.join(dir, "state.json");
  const ledger = new MemoryLedger();
  setMirrorLedgerForTest(ledger);

  const fp = paperPhysicalAccountFingerprint("50206021");
  ledger.snapshot.users.set(USER_ID, {
    id: USER_ID,
    email: "u@test.local",
    displayName: "test",
    role: "USER",
    status: "ACTIVE",
    createdAt: "2026-01-01 00:00:00.000000",
    updatedAt: "2026-01-01 00:00:00.000000",
  });
  ledger.snapshot.brokerAccounts.set(ACCOUNT_ID, {
    id: ACCOUNT_ID,
    userId: USER_ID,
    broker: "KIS",
    environment: "PAPER",
    displayName: "KIS PAPER",
    accountNumberMasked: "****6021",
    baseCurrency: "KRW",
    status: "ACTIVE",
    isDefault: true,
    credentialRef: null,
    physicalAccountFingerprint: fp,
  });

  const instrumentId = instrumentIdFor("005930");
  ledger.snapshot.instruments.set(instrumentId, {
    id: instrumentId,
    country: "KR",
    market: "KOSPI",
    symbol: "005930",
    displayName: "삼성전자",
    currency: "KRW",
    kisExchangeCode: null,
    instrumentType: "EQUITY",
    isActive: true,
  });

  const dbOrderId = "db-newer-order";
  const orderPk = stableId("order", `${ACCOUNT_ID}:${dbOrderId}`);
  ledger.snapshot.orders.set(orderPk, {
    id: orderPk,
    brokerAccountId: ACCOUNT_ID,
    instrumentId,
    intentId: null,
    localOrderId: dbOrderId,
    brokerOrderNo: "0000012345",
    brokerOrderDate: "20261020",
    brokerOrgNo: null,
    side: "BUY",
    orderType: "LIMIT",
    requestedQty: money(2),
    requestedPrice: money(71_000),
    filledQty: money(2),
    remainingQty: money(0),
    averageFillPrice: money(71_000),
    currency: "KRW",
    status: "FILLED",
    source: "SEED",
    sourceId: null,
    ruleKey: "cash",
    reason: "db-newer",
    submittedAt: "2026-10-20 12:00:00.000000",
    acceptedAt: "2026-10-20 12:00:00.000000",
    completedAt: "2026-10-20 12:00:00.000000",
    createdAt: "2026-10-20 12:00:00.000000",
    updatedAt: "2026-10-20 12:00:00.000000",
  });

  const stale = createPaperState();
  stale.orders = [
    {
      id: "json-stale-pending",
      createdAt: "2026-10-19T01:00:00.000Z",
      source: "rule",
      ruleId: "cash",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70_000,
      amount: 70_000,
      commission: 0,
      tax: 0,
      net: 0,
      status: "pending",
    },
  ];
  writeFileSync(statePath, JSON.stringify(stale));

  try {
    const store = createTradingStateStore({
      statePath,
      brokerAccountId: ACCOUNT_ID,
    });
    const loaded = await store.getState();
    assert.ok(
      loaded.orders.some((o) => o.id === dbOrderId && o.status === "filled"),
      "DB filled order must be present",
    );
    assert.ok(
      !loaded.orders.some((o) => o.id === "json-stale-pending"),
      "stale JSON pending must not win over DB book",
    );
  } finally {
    setMirrorLedgerForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
