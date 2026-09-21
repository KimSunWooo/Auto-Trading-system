/**
 * Overseas PAPER server-ready dry validation (Tests A–U).
 * Never posts real KIS overseas orders. Opt-in stays OFF unless a test temporarily sets it on a mock client.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import type { Order } from "@/lib/types";
import { KisClient, resetKisTokenCacheForTest } from "@/src/brokers/kis-client";
import { getKisConfig, KIS_HOSTS } from "@/src/brokers/kis-config";
import { BrokerRejectError, IndeterminateOrderError, OrderTimeoutError } from "@/src/risk/errors";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { overseasPaperOrdersLocked, vtsOverseasOrderTestsEnabled } from "@/src/markets/overseas/env";
import { pickUsdCash } from "@/src/markets/overseas/fx";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import {
  applyExecutionToLocalQty,
  classifyOverseasRestart,
  overseasCancelAllowed,
  overseasFirstLifecycleQtyOk,
  overseasQuoteOrderableGate,
  overseasSellQtyAllowed,
  overseasServerStartupAutoOrderSafe,
  OVERSEAS_FIRST_LIFECYCLE_QTY,
} from "@/src/markets/overseas/lifecycle";
import { mapOverseasExecution, mapOverseasOpenOrder, mapForeignCashRows } from "@/src/markets/overseas/mapping";
import { normalizeOverseasLimitPrice } from "@/src/markets/overseas/price";
import { overseasBuyCashGate, overseasVtsBPreflight } from "@/src/markets/overseas/preflight";
import { overseasActivationGate, emptyOverseasRecovery } from "@/src/markets/overseas/activation-gate";
import { runOverseasPaperSync } from "@/src/markets/overseas/sync";
import { findIntent } from "@/src/runtime/intents";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import type { OverseasQuote } from "@/src/markets/overseas/types";
import { recordMirrorDegraded, resetDatabaseStatusForTest } from "@/src/db/status";

const PAPER_ENV = {
  BROKER: "kis",
  TRADING_MODE: "live_test",
  KIS_MODE: "demo",
  ALLOW_LIVE_TRADING: "false",
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
  PERSISTENCE_MODE: "mirror",
  DATABASE_URL: "mysql://app:x@127.0.0.1:3306/auto_trading",
} as const;

function clearEnv() {
  for (const key of [
    ...Object.keys(PAPER_ENV),
    "RUN_KIS_VTS_OVERSEAS_ORDER_TESTS",
    "RUN_KIS_VTS_ORDER_TESTS",
    "KIS_LIVE_CONFIRM",
    "PAPER_POLICY_MODE",
    "DATABASE_URL",
  ]) {
    delete process.env[key];
  }
}

function applyPaper() {
  clearEnv();
  Object.assign(process.env, PAPER_ENV);
}

afterEach(() => {
  clearEnv();
  resetDatabaseStatusForTest();
});

function openQuote(partial: Partial<OverseasQuote> = {}): OverseasQuote {
  return {
    identity: "NYSE:F",
    symbol: "F",
    exchange: "NYSE",
    displayName: "Ford",
    currency: "USD",
    price: 11.25,
    prevClose: 11,
    change: 0.25,
    changeRate: 2.2,
    open: 11,
    high: 11.4,
    low: 10.9,
    volume: 1,
    timestamp: new Date().toISOString(),
    source: "kis",
    orderable: true,
    marketStatus: "open",
    ...partial,
  };
}

test("Test A: Overseas opt-in OFF → BUY BLOCK", async () => {
  applyPaper();
  assert.equal(vtsOverseasOrderTestsEnabled(), false);
  assert.match(overseasPaperOrdersLocked() ?? "", /RUN_KIS_VTS_OVERSEAS_ORDER_TESTS/);
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      return { orderNo: "x" };
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const r = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:a",
    signalId: "sig:ov:a",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "rejected");
  assert.equal(posts, 0);
});

test("Test B: REAL flag present → ABORT / BLOCK", () => {
  applyPaper();
  process.env.KIS_MODE = "real";
  process.env.ALLOW_LIVE_TRADING = "true";
  process.env.KIS_LIVE_CONFIRM = "I_UNDERSTAND";
  process.env.TRADING_MODE = "live";
  assert.match(overseasPaperOrdersLocked() ?? "", /REAL/);
  const gate = overseasVtsBPreflight({
    env: process.env,
    quoteHealthy: true,
    foreignBalanceHealthy: true,
    reconciliationHealthy: true,
    marketStatus: "open",
    riskHealthy: true,
    usdCash: 100,
    usdOrderable: 100,
    nativePrice: 11,
    fxRate: 1300,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.checks.realDisabled, "FAIL");
});

test("Test C: USD cash=0 + USD orderable>price → funding gate PASS", () => {
  applyPaper();
  const { cash } = mapForeignCashRows(
    [{ crcy_cd: "USD", frcr_dncl_amt_2: "0", frcr_use_psbl_amt: "50", frst_bltn_exrt: "1350" }],
    null,
  );
  const usd = pickUsdCash(cash);
  assert.equal(usd?.cash, 0);
  assert.equal(usd?.orderableCash, 50);
  assert.equal(overseasBuyCashGate(usd?.orderableCash).ok, true);
  assert.notEqual(usd?.cash, usd?.orderableCash);
});

test("Test D: USD orderable=0 → BUY BLOCK", () => {
  assert.equal(overseasBuyCashGate(0).ok, false);
  assert.equal(overseasBuyCashGate(null).ok, false);
});

test("Test E: qty=1 → first lifecycle eligible", () => {
  assert.equal(OVERSEAS_FIRST_LIFECYCLE_QTY, 1);
  assert.equal(overseasFirstLifecycleQtyOk(1).ok, true);
  assert.equal(overseasFirstLifecycleQtyOk(2).ok, false);
  assert.equal(overseasFirstLifecycleQtyOk(5).ok, false);
});

test("Test F: same Intent twice → submit max 1", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      return { orderNo: "ODNO-F1" };
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const input = {
    intentId: "sig:ov:f",
    signalId: "sig:ov:f",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy" as const,
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false as const,
  };
  const a = await adapter.submitLimitOnce(box, input);
  const b = await adapter.submitLimitOnce(box, input);
  assert.equal(a.ok, true);
  assert.equal(posts, 1);
  assert.equal(b.orderNo, a.orderNo);
  assert.equal(posts, 1);
});

test("Test G: existing open BUY → next BUY BLOCK", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      return { orderNo: "ODNO-G" };
    },
  } as unknown as KisClient);
  const state = createPaperState();
  state.orders = [
    {
      id: "open1",
      createdAt: new Date().toISOString(),
      source: "rule",
      code: "NYSE:F",
      name: "Ford",
      side: "buy",
      qty: 1,
      price: 11,
      amount: 11,
      commission: 0,
      tax: 0,
      net: 11,
      status: "pending",
      brokerOrderNo: "0001",
      ruleId: "overseas",
    },
  ];
  const box = { current: state };
  const r = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:g",
    signalId: "sig:ov:g",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /Existing open BUY/);
  assert.equal(posts, 0);
});

test("Test H: Broker deterministic reject → REJECTED", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      throw new BrokerRejectError("모의투자 주문거부: 잔고부족");
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const r = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:h",
    signalId: "sig:ov:h",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.equal(r.status, "rejected");
  assert.equal(findIntent(box.current, "sig:ov:h")?.status, "rejected");
  assert.equal(posts, 1);
});

test("Test I: timeout / indeterminate → UNKNOWN", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      throw new OrderTimeoutError();
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const r = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:i",
    signalId: "sig:ov:i",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.equal(r.status, "unknown");
  assert.equal(findIntent(box.current, "sig:ov:i")?.status, "unknown");
});

test("Test J: UNKNOWN → second submit 0", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      throw new IndeterminateOrderError("connection lost after accept?");
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const input = {
    intentId: "sig:ov:j",
    signalId: "sig:ov:j",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy" as const,
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false as const,
  };
  const first = await adapter.submitLimitOnce(box, input);
  assert.equal(first.status, "unknown");
  assert.equal(posts, 1);
  const second = await adapter.submitLimitOnce(box, input);
  assert.equal(second.status, "unknown");
  assert.equal(posts, 1);
});

test("Test K: ODNO returned → pending, NOT filled", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => ({ orderNo: "0000099999" }),
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  const r = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:k",
    signalId: "sig:ov:k",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "pending");
  assert.equal(r.orderNo, "0000099999");
  assert.equal(box.current.positions.length, 0);
  assert.equal(findIntent(box.current, "sig:ov:k")?.status, "submitted");
});

test("Test L: exact execution → filled mapping", () => {
  const exec = mapOverseasExecution({
    odno: "100",
    pdno: "F",
    ovrs_excg_cd: "NYSE",
    sll_buy_dvsn_cd: "02",
    ft_ord_qty: "1",
    ft_ccld_qty: "1",
    nccs_qty: "0",
    ft_ord_unpr3: "11.25",
    avg_unpr3: "11.25",
  });
  assert.ok(exec);
  assert.equal(exec.filledQty, 1);
  assert.equal(exec.remainingQty, 0);
  const applied = applyExecutionToLocalQty({
    orderQty: exec.qty,
    filledQty: exec.filledQty,
    remainingQty: exec.remainingQty,
  });
  assert.equal(applied.positionDelta, 1);
  assert.equal(applied.stillActive, false);
});

test("Test M: partial execution → correct filled/remain", () => {
  const exec = mapOverseasExecution({
    odno: "101",
    pdno: "F",
    ovrs_excg_cd: "NYSE",
    sll_buy_dvsn_cd: "02",
    ft_ord_qty: "3",
    ft_ccld_qty: "1",
    nccs_qty: "2",
    ft_ord_unpr3: "11",
  });
  assert.ok(exec);
  assert.equal(exec.qty, 3);
  assert.equal(exec.filledQty, 1);
  assert.equal(exec.remainingQty, 2);
  const applied = applyExecutionToLocalQty({
    orderQty: 3,
    filledQty: 1,
    remainingQty: 2,
  });
  assert.equal(applied.positionDelta, 1);
  assert.equal(applied.stillActive, true);
});

test("Test N: SELL > broker holding → BLOCK", () => {
  const gate = overseasSellQtyAllowed({
    qty: 2,
    identity: "NYSE:F",
    kisPositions: [
      {
        identity: "NYSE:F",
        instrument: makeUsInstrument("NYSE", "F"),
        qty: 1,
        avgPrice: 11,
        last: 11,
        marketValue: 11,
        currency: "USD",
        krwEquivalent: null,
      },
    ],
  });
  assert.equal(gate.ok, false);
  assert.match(gate.blocked ?? "", /exceeds/);
});

test("Test O: cancel wrong ODNO → BLOCK / no POST", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const open = [
    mapOverseasOpenOrder({
      odno: "555",
      pdno: "F",
      ovrs_excg_cd: "NYSE",
      sll_buy_dvsn_cd: "02",
      ft_ord_qty: "1",
      ft_ccld_qty: "0",
      nccs_qty: "1",
      ft_ord_unpr3: "11",
    })!,
  ];
  const blocked = overseasCancelAllowed({
    orderNo: "999",
    instrument: makeUsInstrument("NYSE", "F"),
    qty: 1,
    openOrders: open,
  });
  assert.equal(blocked.ok, false);
  const adapter = new OverseasTradingAdapter({
    cancelOverseasOrder: async () => {
      posts += 1;
    },
  } as unknown as KisClient);
  await assert.rejects(
    () =>
      adapter.cancelExact(
        { instrument: makeUsInstrument("NYSE", "F"), orderNo: "999", qty: 1 },
        { openOrders: open },
      ),
    /ODNO|Cancel/,
  );
  assert.equal(posts, 0);
});

test("Test P: restart with active matched ODNO → recover / no duplicate BUY", () => {
  const local: Order = {
    id: "o1",
    createdAt: new Date().toISOString(),
    source: "rule",
    code: "NYSE:F",
    name: "Ford",
    side: "buy",
    qty: 1,
    price: 11,
    amount: 11,
    commission: 0,
    tax: 0,
    net: 11,
    status: "pending",
    brokerOrderNo: "0000000555",
    ruleId: "overseas",
    intentId: "sig:ov:p",
  };
  const open = [
    mapOverseasOpenOrder({
      odno: "0000000555",
      pdno: "F",
      ovrs_excg_cd: "NYSE",
      sll_buy_dvsn_cd: "02",
      ft_ord_qty: "1",
      nccs_qty: "1",
      ft_ccld_qty: "0",
      ft_ord_unpr3: "11",
    })!,
  ];
  const r = classifyOverseasRestart({
    localOrders: [local],
    openOrders: open,
    executions: [],
  });
  assert.equal(r.status, "ACTIVE_MATCHED");
  assert.equal(r.blocksNewBuy, true);
});

test("Test Q: restart with unresolved UNKNOWN → trading block", () => {
  const r = classifyOverseasRestart({
    localIntents: [
      {
        intentId: "sig:ov:q",
        signalId: "sig:ov:q",
        ruleId: "overseas",
        ticker: "NYSE:F",
        side: "buy",
        qty: 1,
        price: 11,
        createdAt: new Date().toISOString(),
        reason: "timeout",
        status: "unknown",
      },
    ],
    localOrders: [],
    openOrders: [],
    executions: [],
  });
  assert.equal(r.status, "UNKNOWN_BLOCKING");
  assert.equal(r.blocksNewBuy, true);
});

test("Test R: KIS active order missing locally → recover or block", () => {
  const open = [
    mapOverseasOpenOrder({
      odno: "777",
      pdno: "F",
      ovrs_excg_cd: "NYSE",
      sll_buy_dvsn_cd: "02",
      ft_ord_qty: "1",
      nccs_qty: "1",
      ft_ccld_qty: "0",
      ft_ord_unpr3: "11",
    })!,
  ];
  const r = classifyOverseasRestart({
    localOrders: [],
    openOrders: open,
    executions: [],
  });
  assert.equal(r.status, "REMOTE_ONLY");
  assert.equal(r.blocksNewBuy, true);
});

test("Test S: DB mirror failure must not imply broker retry (opt-in OFF)", async () => {
  applyPaper();
  assert.equal(overseasServerStartupAutoOrderSafe(), true);
  assert.equal(vtsOverseasOrderTestsEnabled(), false);
  // Sync refuses when opt-in on; with opt-in off and mock failures, state preserved.
  const state = createPaperState();
  state.startupSync = {
    status: "HEALTHY",
    recoveredOrders: 0,
    orphanedOrders: 0,
    positionChanges: 0,
    executionChanges: 0,
  };
  const client = {
    inquireOverseasOpenOrders: async () => {
      throw new Error("DB_MIRROR_DEGRADED fixture");
    },
    inquireOverseasExecutions: async () => [],
    inquireOverseasBalance: async () => ({ positions: [], raw: {} }),
  } as unknown as KisClient;
  const result = await runOverseasPaperSync(state, client);
  assert.equal(result.state.startupSync?.status, "HEALTHY");
  assert.equal(result.sync.orderPosts, 0);
});

test("Test T: dry order transport — price normalized, real host never, POST counted only on mock", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  resetKisTokenCacheForTest();
  assert.equal(normalizeOverseasLimitPrice(12.3400000001), "12.34");
  assert.equal(normalizeOverseasLimitPrice(11), "11");
  let bodyPrice: string | undefined;
  let realHits = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) {
      realHits += 1;
      throw new Error("REAL host forbidden");
    }
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && /\/oauth2\/tokenP/.test(url)) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && /hashkey/.test(url)) {
      return new Response(JSON.stringify({ HASH: "h" }), { status: 200 });
    }
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && /\/trading\/order/.test(url)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
      bodyPrice = body.OVRS_ORD_UNPR;
      return new Response(JSON.stringify({ rt_cd: "0", msg_cd: "ok", msg1: "ok", output: { ODNO: "888" } }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ rt_cd: "0", output: {} }), { status: 200 });
  };
  const client = new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: "paper-key",
      KIS_PAPER_APP_SECRET: "paper-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
    fetchImpl,
  );
  const placed = await client.orderOverseasUs({
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 12.3400000001,
  });
  assert.equal(placed.orderNo, "888");
  assert.equal(bodyPrice, "12.34");
  assert.equal(realHits, 0);
});

test("Test U: REAL endpoint request → 0 in preparation gate", () => {
  applyPaper();
  resetDatabaseStatusForTest();
  const gate = overseasActivationGate({
    env: { ...PAPER_ENV },
    quote: openQuote({ marketStatus: "closed", orderable: null }),
    usdCash: 0,
    usdOrderable: 50,
    orderableQty: 4,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery: emptyOverseasRecovery(),
    existingOpenBuy: false,
    unknownPresent: false,
    paperOrderPosts: 0,
    realRequests: 0,
    runtimeWorker: "healthy",
    workerLockOk: true,
    persistenceHealthy: true,
  });
  assert.equal(gate.checks.realRequests, "PASS");
  assert.equal(gate.checks.orderOptIn, "OFF");
  assert.equal(gate.blocked, "WAITING FOR MARKET");
  assert.equal(gate.runtime, "WAITING FOR MARKET");
  assert.equal(gate.firstLifecycleQty, 1);
  assert.equal(gate.fxExecutionApi, "NO");
  assert.equal(KIS_CURRENCY_EXCHANGE_AUDIT.paperVtsExecutionSupported, "NO");
});

test("quote orderable null/false/true semantics", () => {
  assert.equal(overseasQuoteOrderableGate(openQuote({ orderable: true })).ok, true);
  assert.equal(overseasQuoteOrderableGate(openQuote({ orderable: false })).ok, false);
  assert.equal(overseasQuoteOrderableGate(openQuote({ orderable: null, marketStatus: "open" })).ok, true);
  assert.equal(overseasQuoteOrderableGate(openQuote({ orderable: null, marketStatus: "closed" })).ok, false);
});

test("persist-before-submit: intent exists after reject path before second POST", async () => {
  applyPaper();
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  let posts = 0;
  const adapter = new OverseasTradingAdapter({
    orderOverseasUs: async () => {
      posts += 1;
      throw new BrokerRejectError("reject-after-intent");
    },
  } as unknown as KisClient);
  const box = { current: createPaperState() };
  await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:persist",
    signalId: "sig:ov:persist",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.ok(findIntent(box.current, "sig:ov:persist"));
  // Crash-window simulation: intent already present → no second POST
  const again = await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:persist",
    signalId: "sig:ov:persist",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });
  assert.equal(posts, 1);
  assert.equal(again.status, "rejected");
});

test("Case A restart: no local / no remote → HEALTHY", () => {
  const r = classifyOverseasRestart({ localOrders: [], openOrders: [], executions: [] });
  assert.equal(r.status, "HEALTHY");
  assert.equal(r.blocksNewBuy, false);
});

test("server startup auto-order safe when opt-in unset", () => {
  applyPaper();
  assert.equal(overseasServerStartupAutoOrderSafe(), true);
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";
  assert.equal(overseasServerStartupAutoOrderSafe(), false);
});

test("Test A: worker undefined → overseas runtime BLOCK", () => {
  applyPaper();
  const gate = overseasActivationGate({
    env: { ...PAPER_ENV },
    quote: openQuote({ marketStatus: "closed", orderable: null }),
    usdCash: 10,
    usdOrderable: 50,
    orderableQty: 4,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery: emptyOverseasRecovery(),
    existingOpenBuy: false,
    unknownPresent: false,
    runtimeWorker: undefined,
    workerLockOk: true,
  });
  assert.equal(gate.runtime, "BLOCKED");
  assert.equal(gate.checks.workerRuntime, "FAIL");
  assert.match(gate.blocked ?? "", /Worker runtime/);
});

test("Test B: worker unhealthy → BLOCK", () => {
  applyPaper();
  const gate = overseasActivationGate({
    env: { ...PAPER_ENV },
    quote: openQuote({ marketStatus: "closed", orderable: null }),
    usdCash: 10,
    usdOrderable: 50,
    orderableQty: 4,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery: emptyOverseasRecovery(),
    existingOpenBuy: false,
    unknownPresent: false,
    runtimeWorker: "unhealthy",
    workerLockOk: true,
  });
  assert.equal(gate.runtime, "BLOCKED");
  assert.equal(gate.checks.workerRuntime, "FAIL");
});

test("Test C: worker lock unhealthy → BLOCK", () => {
  applyPaper();
  const gate = overseasActivationGate({
    env: { ...PAPER_ENV },
    quote: openQuote({ marketStatus: "closed", orderable: null }),
    usdCash: 10,
    usdOrderable: 50,
    orderableQty: 4,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery: emptyOverseasRecovery(),
    existingOpenBuy: false,
    unknownPresent: false,
    runtimeWorker: "healthy",
    workerLockOk: false,
  });
  assert.equal(gate.runtime, "BLOCKED");
  assert.equal(gate.checks.workerLock, "FAIL");
});

test("Test D: RDS degraded → new overseas BUY readiness BLOCK", () => {
  applyPaper();
  recordMirrorDegraded("fixture");
  try {
    const gate = overseasActivationGate({
      env: { ...PAPER_ENV },
      quote: openQuote({ marketStatus: "closed", orderable: null }),
      usdCash: 10,
      usdOrderable: 50,
      orderableQty: 4,
      presentBalanceOk: true,
      positionsOk: true,
      openOrdersOk: true,
      executionsOk: true,
      recovery: emptyOverseasRecovery(),
      existingOpenBuy: false,
      unknownPresent: false,
      runtimeWorker: "healthy",
      workerLockOk: true,
    });
    assert.equal(gate.runtime, "BLOCKED");
    assert.equal(gate.checks.rdsMirror, "FAIL");
  } finally {
    resetDatabaseStatusForTest();
  }
});

test("Test H2: local pending + exact execution ODNO → EXECUTION_MATCHED", () => {
  const local: Order = {
    id: "o1",
    createdAt: new Date().toISOString(),
    source: "rule",
    code: "NYSE:F",
    name: "Ford",
    side: "buy",
    qty: 1,
    price: 11,
    amount: 11,
    commission: 0,
    tax: 0,
    net: 11,
    status: "pending",
    brokerOrderNo: "0000000999",
    ruleId: "overseas",
    intentId: "sig:ov:h2",
  };
  const exec = [
    mapOverseasExecution({
      odno: "0000000999",
      pdno: "F",
      ovrs_excg_cd: "NYSE",
      sll_buy_dvsn_cd: "02",
      ft_ord_qty: "1",
      ft_ccld_qty: "1",
      nccs_qty: "0",
      ft_ord_unpr3: "11",
      ft_ccld_unpr3: "11",
    })!,
  ];
  const r = classifyOverseasRestart({
    localOrders: [local],
    openOrders: [],
    executions: exec,
  });
  assert.equal(r.status, "EXECUTION_MATCHED");
  assert.equal(r.blocksNewBuy, false);
});

test("hardcoded workerHealthy:true alone does not PASS", () => {
  applyPaper();
  const gate = overseasActivationGate({
    env: { ...PAPER_ENV },
    quote: openQuote({ marketStatus: "closed", orderable: null }),
    usdCash: 10,
    usdOrderable: 50,
    orderableQty: 4,
    presentBalanceOk: true,
    positionsOk: true,
    openOrdersOk: true,
    executionsOk: true,
    recovery: emptyOverseasRecovery(),
    existingOpenBuy: false,
    unknownPresent: false,
    workerHealthy: true,
    workerLockOk: true,
  });
  assert.equal(gate.checks.workerRuntime, "FAIL");
  assert.equal(gate.runtime, "BLOCKED");
});
