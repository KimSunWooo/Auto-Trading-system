/**
 * Domestic VTS-B2 + RDS 3-way consistency.
 * Places at most one KIS PAPER BUY (qty=1). Never SELL/CANCEL/FLATTEN/REAL/overseas.
 * Production trading core is not modified.
 */
import mysql from "mysql2/promise";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createPaperState } from "@/lib/engine";
import { getMarketClock } from "@/lib/market-hours";
import { persistStateNow } from "@/lib/store";
import { KisBroker } from "@/src/brokers/KisBroker";
import { KisClient, sameOdno } from "@/src/brokers/kis-client";
import { KIS_HOSTS, loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { dbConfigured, loadDbConnection, persistenceMode } from "@/src/db/config";
import { loadLocalEnv } from "@/src/db/load-env";
import { getMysqlLedger } from "@/src/db/mysql-ledger";
import { resetDbClientForTest } from "@/src/db/client";
import { moneyNumber } from "@/src/db/money";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { CASH_RULE_ID } from "@/src/rules/params";
import { cashFromAllocations } from "@/src/accounts/defaults";
import { diffLocalVsKis } from "@/src/risk/balance-sync";
import { checkHardLimits } from "@/src/risk/limits";
import { PAPER_ORDER_POLICY, REAL_ORDER_POLICY, usesPaperOrderPolicy } from "@/src/risk/order-policy";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { emptySafety } from "@/src/runtime/safety";
import {
  appendVtsEvent,
  assertVtsSafeEnv,
  beginVtsTestRun,
  envSnapshotWithoutSecrets,
  finishVtsTestRun,
  redactSecrets,
  vtsOrderEligibility,
  writeVtsReconciliation,
  type VtsRunOutcome,
} from "@/src/runtime/vts-harness";
import { tryAcquireWorkerLock } from "@/src/runtime/worker-lock";
import type { AppState, Position } from "@/lib/types";

const TICKER = "005930";
const COUNT_TABLES = [
  "users",
  "broker_accounts",
  "order_intents",
  "orders",
  "order_events",
  "executions",
  "positions",
  "trades",
  "cash_balance_snapshots",
  "account_snapshots",
  "reconciliation_runs",
  "reconciliation_items",
] as const;

type Counts = Record<(typeof COUNT_TABLES)[number], number>;
type HttpCounts = {
  paperHost: number;
  realHost: number;
  domesticOrderCash: number;
  domesticCancel: number;
  overseasOrder: number;
};

function forcePaperLiveTestEnv() {
  loadLocalEnv();
  process.env.BROKER = "kis";
  process.env.TRADING_MODE = "live_test";
  process.env.KIS_MODE = "demo";
  process.env.PERSISTENCE_MODE = "mirror";
  process.env.RUN_KIS_VTS_ORDER_TESTS = "true";
  process.env.ALLOW_LIVE_TRADING = "false";
  delete process.env.KIS_LIVE_CONFIRM;
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_FLATTEN_TEST;
  delete process.env.RUN_KIS_VTS_OVERSEAS_TESTS;
}

function padTicker(code: string): string {
  return code.replace(/\D/g, "").slice(-6).padStart(6, "0");
}

function qtyOf(positions: Array<{ code: string; qty: number }>, ticker: string): number {
  const code = padTicker(ticker);
  return positions
    .filter((row) => padTicker(row.code) === code)
    .reduce((sum, row) => sum + row.qty, 0);
}

function installHttpGuard(): { counts: HttpCounts; restore: () => void } {
  const counts: HttpCounts = {
    paperHost: 0,
    realHost: 0,
    domesticOrderCash: 0,
    domesticCancel: 0,
    overseasOrder: 0,
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("openapi.koreainvestment.com:9443")) counts.realHost += 1;
    if (url.includes("openapivts.koreainvestment.com:29443")) counts.paperHost += 1;
    const pathOnly = url.split("?")[0] ?? url;
    if (pathOnly.includes("/uapi/domestic-stock/v1/trading/order-cash")) counts.domesticOrderCash += 1;
    if (pathOnly.includes("/uapi/domestic-stock/v1/trading/order-rvsecncl")) counts.domesticCancel += 1;
    if (pathOnly.includes("/uapi/overseas-stock/v1/trading/order")) counts.overseasOrder += 1;
    return orig(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    counts,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

async function withMysql<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const cfg = loadDbConnection();
  if (!cfg) throw new Error("ORDER TEST BLOCKED: RDS connection is not configured");
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

async function rdsCounts(): Promise<Counts> {
  return withMysql(async (conn) => {
    const out = {} as Counts;
    for (const table of COUNT_TABLES) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
      out[table] = Number(rows[0]?.n ?? 0);
    }
    return out;
  });
}

function writeJson(dir: string, name: string, value: unknown) {
  writeFileSync(path.join(dir, name), `${redactSecrets(JSON.stringify(value, null, 2))}\n`, "utf8");
}

function alignJsonToKis(state: AppState, remote: { cash: number; d2Cash: number; holdings: Array<{ ticker: string; name: string; qty: number; avgPrice: number }> }): AppState {
  const cash = Math.max(0, Math.round(remote.cash));
  const allocations = state.allocations.map((row) =>
    row.ruleId === CASH_RULE_ID
      ? { ...row, budget: Math.max(row.budget, cash), balance: cash, enabled: true, lastMessage: "KIS PAPER snapshot" }
      : { ...row, enabled: false },
  );
  const positions: Position[] = remote.holdings
    .filter((row) => row.qty > 0)
    .map((row) => {
      const code = padTicker(row.ticker);
      const prev = state.positions.find((pos) => padTicker(pos.code) === code);
      return {
        code,
        name: row.name || prev?.name || code,
        qty: row.qty,
        avgPrice: row.avgPrice > 0 ? row.avgPrice : (prev?.avgPrice ?? 0),
        ruleId: prev?.ruleId ?? CASH_RULE_ID,
      };
    });
  return {
    ...state,
    allocations,
    cash: cashFromAllocations(allocations),
    positions,
    lastBalanceSyncAt: Date.now(),
    kisBalance: {
      syncedAt: new Date().toISOString(),
      cash: remote.cash,
      d2Cash: remote.d2Cash,
      holdings: remote.holdings,
      cashDelta: 0,
      matched: true,
      message: "preflight KIS snapshot",
    },
    safety: {
      ...emptySafety(),
      quoteOk: true,
      brokerConnected: true,
      workerHealthy: true,
      reconciliation: "synced",
    },
    settings: {
      ...state.settings,
      autoTrading: false,
      disclaimerAccepted: true,
      onboardingComplete: true,
      liquidating: false,
      ignoreMarketHours: false,
    },
  };
}

async function main() {
  forcePaperLiveTestEnv();
  assertVtsSafeEnv();

  if (!REAL_ORDER_POLICY.enforceAmountCaps) {
    throw new Error("REAL_ORDER_POLICY amount caps missing");
  }
  if (PAPER_ORDER_POLICY.maxQtyPerOrder !== 1) {
    throw new Error("PAPER_ORDER_POLICY maxQtyPerOrder is not 1");
  }
  if (typeof checkHardLimits !== "function") {
    throw new Error("checkHardLimits missing");
  }

  const eligibility = vtsOrderEligibility();
  const http = installHttpGuard();
  const run = beginVtsTestRun("VTS-B2-RDS-DOMESTIC");
  let outcome: VtsRunOutcome = "PASS";
  let blocked: string | null = null;
  const report: Record<string, unknown> = {
    gate: "Domestic VTS-B2 + RDS 3-Way Consistency",
    testRunId: run.testRunId,
  };

  const block = (reason: string) => {
    blocked = reason.startsWith("ORDER TEST BLOCKED") ? reason : `ORDER TEST BLOCKED: ${reason}`;
    outcome = "BLOCKED";
    appendVtsEvent(run.dir, { type: "blocked", reason: blocked });
  };

  try {
    writeJson(run.dir, "env.json", envSnapshotWithoutSecrets());
    const cfg = loadKisConfig();
    if (cfg.environment !== "paper" || cfg.host !== KIS_HOSTS.paper) {
      block("KIS host is not PAPER VTS");
      return;
    }
    if (resolveKisEnvironment() !== "paper") {
      block("KIS_MODE is not paper/demo");
      return;
    }
    if (!usesPaperOrderPolicy()) {
      block("PAPER_ORDER_POLICY is not active");
      return;
    }
    if (persistenceMode() !== "mirror") {
      block("PERSISTENCE_MODE must be mirror");
      return;
    }
    if (!dbConfigured() || !loadDbConnection()) {
      block("RDS is not configured");
      return;
    }

    const dbStatus = publicDatabaseStatus();
    if (!dbStatus.enabled) {
      block("DB enabled is not true");
      return;
    }

    await withMysql(async (conn) => {
      await conn.query("SELECT 1");
    });

    if (!tryAcquireWorkerLock("vts-b2-rds", { filePath: run.lockPath })) {
      block("worker lock not held");
      return;
    }

    if (!eligibility.ok) {
      block(eligibility.blocked ?? "order eligibility failed");
      return;
    }

    const clock = getMarketClock();
    writeJson(run.dir, "preflight-market.json", {
      iso: clock.iso,
      open: clock.open,
      sessionLabel: clock.sessionLabel,
      weekday: clock.weekday,
      hhmm: clock.hhmm,
      holiday: clock.holiday,
    });
    if (!clock.open) {
      block(`Market CLOSED (${clock.sessionLabel} ${clock.iso})`);
      return;
    }

    const client = KisClient.fromEnv();
    if (client.mode !== "paper") {
      block("KisClient mode is not paper");
      return;
    }

    const quote = await client.inquirePrice(TICKER);
    writeJson(run.dir, "quote.json", {
      symbol: TICKER,
      name: quote.name,
      price: quote.price,
      open: quote.open,
      prevClose: quote.prevClose,
    });
    if (!(quote.price > 0)) {
      block("Quote price is not > 0");
      return;
    }

    const balance = await client.inquireBalance();
    writeJson(run.dir, "balance.json", {
      cash: balance.cash,
      d2Cash: balance.d2Cash,
      holdingCount: balance.holdings.length,
      tickerQty: qtyOf(balance.holdings.map((row) => ({ code: row.ticker, qty: row.qty })), TICKER),
    });
    if (!Number.isFinite(balance.cash)) {
      block("Balance inquiry failed");
      return;
    }
    if (balance.d2Cash < quote.price && balance.cash < quote.price) {
      block("KRW orderable is insufficient for 1 share");
      return;
    }

    const open = await client.inquireOpenOrders();
    const existingOpenBuy = open.filter(
      (row) => padTicker(row.ticker) === TICKER && row.side === "buy" && row.unfilledQty > 0,
    );
    writeJson(run.dir, "open-orders-before.json", {
      count: open.length,
      tickerOpenBuys: existingOpenBuy.length,
    });
    if (existingOpenBuy.length > 0) {
      block("Existing open BUY order detected");
      return;
    }

    const executionsBefore = await client.inquireDailyCcld();
    writeJson(run.dir, "executions-before.json", {
      count: executionsBefore.length,
      ticker: executionsBefore.filter((row) => padTicker(row.ticker) === TICKER).length,
    });

    let state = createPaperState();
    state.settings.autoTrading = false;
    state = alignJsonToKis(state, balance);
    state.quotes[TICKER] = {
      ...(state.quotes[TICKER] ?? {
        code: TICKER,
        name: quote.name || "삼성전자",
        market: "KOSPI",
        price: quote.price,
        prevClose: quote.prevClose,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        volume: quote.volume,
        bid: quote.price,
        ask: quote.price,
        history: [quote.price],
      }),
      name: quote.name || "삼성전자",
      price: quote.price,
      prevClose: quote.prevClose,
      source: "kis",
      freshAt: Date.now(),
    };

    const preDiff = diffLocalVsKis(state, balance);
    writeVtsReconciliation(run.dir, { phase: "pre", ...preDiff });
    if (!preDiff.matched) {
      block(`Pre-Reconciliation MISMATCH: ${preDiff.reasons.join(" / ")}`);
      return;
    }

    await persistStateNow(state);
    const afterBootstrap = publicDatabaseStatus();
    if (afterBootstrap.lastError) {
      block(`RDS mirror failed during bootstrap (${afterBootstrap.lastError})`);
      return;
    }

    const dbBefore = await rdsCounts();
    writeJson(run.dir, "db-before.json", dbBefore);
    if (dbBefore.users < 1 || dbBefore.broker_accounts < 1) {
      block("bootstrap user / PAPER broker account missing");
      return;
    }

    const accounts = await getMysqlLedger().transaction((tx) => tx.listBrokerAccounts());
    const realActive = accounts.filter((row) => row.environment === "REAL" && row.status === "ACTIVE");
    if (realActive.length > 0) {
      block("REAL broker account became ACTIVE");
      return;
    }
    const paperAccount = accounts.find((row) => row.environment === "PAPER");
    if (!paperAccount) {
      block("PAPER broker account missing");
      return;
    }

    const ledger = getMysqlLedger();
    const rdsPosBefore = await ledger.transaction((tx) => tx.listPositions(paperAccount.id));
    const instrumentRows = await Promise.all(
      rdsPosBefore.map(async (row) => ({
        row,
        instrument: await ledger.transaction((tx) => tx.getInstrument(row.instrumentId)),
      })),
    );
    const rdsTickerBefore = instrumentRows
      .filter((row) => row.instrument?.symbol === TICKER)
      .reduce((sum, row) => sum + moneyNumber(row.row.quantity), 0);

    const kisQtyBefore = qtyOf(
      balance.holdings.map((row) => ({ code: row.ticker, qty: row.qty })),
      TICKER,
    );
    const jsonQtyBefore = qtyOf(state.positions, TICKER);
    writeJson(run.dir, "positions-before.json", {
      kis: kisQtyBefore,
      json: jsonQtyBefore,
      rds: rdsTickerBefore,
    });

    const clock2 = getMarketClock();
    if (!clock2.open) {
      block(`Market CLOSED at order time (${clock2.sessionLabel})`);
      return;
    }

    const intentId = `sig:vts:${run.testRunId}:b2`;
    const box = { current: state };
    const broker = new KisBroker(box, client, CASH_RULE_ID, "manual", run.testRunId).withIntent({
      intentId,
      signalId: intentId,
    });
    await broker.getQuote(TICKER);

    const submitBefore = http.counts.domesticOrderCash;
    const fill = await broker.buyMarket(TICKER, quote.price);
    await persistStateNow(box.current);
    const submitAfter = http.counts.domesticOrderCash;
    const brokerSubmitCount = submitAfter - submitBefore;

    const sameIntent = await broker.buyMarket(TICKER, quote.price);
    await persistStateNow(box.current);
    if (http.counts.domesticOrderCash !== submitAfter) {
      outcome = "FAIL";
      blocked = "FAIL: same intent caused a second broker submit";
      return;
    }

    const local = box.current.orders.find((row) => row.intentId === intentId && !row.parentOrderId);
    writeJson(run.dir, "order-result.json", {
      ok: fill.ok,
      status: fill.status,
      reason: fill.reason,
      localStatus: local?.status,
      odno: local?.brokerOrderNo ?? null,
      qty: local?.qty,
      filledQty: local?.filledQty,
      brokerSubmitCount,
      sameIntentStatus: sameIntent.status,
    });

    if (http.counts.realHost > 0) {
      outcome = "FAIL";
      blocked = "FAIL: REAL HTTP request occurred";
      return;
    }
    if (http.counts.overseasOrder > 0) {
      outcome = "FAIL";
      blocked = "FAIL: overseas order HTTP occurred";
      return;
    }
    if (http.counts.domesticCancel > 0) {
      outcome = "FAIL";
      blocked = "FAIL: PAPER CANCEL was sent";
      return;
    }
    if (brokerSubmitCount !== 1) {
      outcome = "FAIL";
      blocked = `FAIL: broker submit count ${brokerSubmitCount}`;
      return;
    }

    if (fill.status === "unknown" || local?.status === "unknown") {
      await settleOpenOrders(box, client, Date.now(), { bookOnly: true });
      await persistStateNow(box.current);
    } else if (local && (local.status === "pending" || (local.filledQty ?? 0) < (local.orderedQty ?? local.qty))) {
      for (let i = 0; i < 5 && (box.current.orders.find((row) => row.id === local.id)?.status === "pending"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await settleOpenOrders(box, client, Date.now(), { bookOnly: true });
      }
      await persistStateNow(box.current);
    }

    const latest = box.current.orders.find((row) => row.intentId === intentId && !row.parentOrderId);
    const odno = latest?.brokerOrderNo ?? null;
    const mirrorStatus = publicDatabaseStatus();
    if (mirrorStatus.lastError) {
      writeJson(run.dir, "mirror-error.json", { error: mirrorStatus.lastError });
      outcome = "FAIL";
      blocked = `DB_MIRROR_DEGRADED after submit: ${mirrorStatus.lastError}`;
      return;
    }

    const executionsAfter = await client.inquireDailyCcld();
    const kisFills = odno ? executionsAfter.filter((row) => sameOdno(row.orderNo, odno)) : [];
    const kisFilledQty = kisFills.reduce((sum, row) => sum + (row.filledQty || 0), 0) || (latest?.filledQty ?? 0);
    writeJson(run.dir, "executions-after.json", {
      odno,
      matchCount: kisFills.length,
      filledQty: kisFilledQty,
    });

    const kisAfter = await client.inquireBalance();
    const kisQtyAfter = qtyOf(
      kisAfter.holdings.map((row) => ({ code: row.ticker, qty: row.qty })),
      TICKER,
    );
    const jsonQtyAfter = qtyOf(box.current.positions, TICKER);
    writeJson(run.dir, "positions-after.json", {
      kis: kisQtyAfter,
      json: jsonQtyAfter,
    });

    const postDiff = diffLocalVsKis(box.current, kisAfter);
    writeJson(run.dir, "reconciliation.json", { phase: "post", ...postDiff });

    const dbAfter = await rdsCounts();
    writeJson(run.dir, "db-after.json", dbAfter);

    const intents = await ledger.transaction((tx) => tx.getIntentByKey(paperAccount.id, intentId));
    const rdsOrder = latest
      ? await ledger.transaction((tx) => tx.getOrderByLocalId(paperAccount.id, latest.id))
      : undefined;
    const rdsPosAfterRows = await ledger.transaction((tx) => tx.listPositions(paperAccount.id));
    const rdsPosAfterDetailed = await Promise.all(
      rdsPosAfterRows.map(async (row) => ({
        row,
        instrument: await ledger.transaction((tx) => tx.getInstrument(row.instrumentId)),
      })),
    );
    const rdsQtyAfter = rdsPosAfterDetailed
      .filter((row) => row.instrument?.symbol === TICKER)
      .reduce((sum, row) => sum + moneyNumber(row.row.quantity), 0);
    const buys = await ledger.transaction((tx) => tx.listBuyHistory({ account: paperAccount.id, symbol: TICKER, limit: 20 }));
    const trades = await ledger.transaction((tx) => tx.listTrades({ account: paperAccount.id, symbol: TICKER, limit: 20 }));
    const buyForOdno = buys.items.filter((row) => (odno ? row.brokerOrderNo === odno : false));
    const cashSnap = await ledger.transaction((tx) => tx.lastCashSnapshot(paperAccount.id, "KRW"));
    const accountSnap = await ledger.transaction((tx) => tx.lastAccountSnapshot(paperAccount.id));
    const reconRun = await ledger.transaction((tx) => tx.lastReconRun(paperAccount.id));

    const jsonFilled = latest?.filledQty ?? 0;
    const jsonExecs = box.current.orders.filter((row) => row.parentOrderId === latest?.id && row.status === "filled");
    const rdsFilled = rdsOrder ? moneyNumber(rdsOrder.filledQty) : 0;

    writeJson(run.dir, "summary.json", {
      intentId,
      odno,
      orderStatus: latest?.status ?? fill.status,
      brokerSubmitCount,
      jsonFilled,
      rdsFilled,
      kisQtyBefore,
      jsonQtyBefore,
      rdsQtyBefore: rdsTickerBefore,
      kisQtyAfter,
      jsonQtyAfter,
      rdsQtyAfter,
      http: http.counts,
      postReconMatched: postDiff.matched,
      postReconReasons: postDiff.reasons,
      intent: intents
        ? { key: intents.intentKey, side: intents.side, qty: moneyNumber(intents.quantity), status: intents.status }
        : null,
      rdsOrder: rdsOrder
        ? {
            localOrderId: rdsOrder.localOrderId,
            brokerOrderNo: rdsOrder.brokerOrderNo,
            status: rdsOrder.status,
            qty: moneyNumber(rdsOrder.requestedQty),
            filledQty: moneyNumber(rdsOrder.filledQty),
          }
        : null,
      buyHistoryCount: buyForOdno.length,
      tradeCount: trades.items.length,
      tradeStatus: trades.items[0]?.status ?? null,
      cashSnapshot: cashSnap
        ? { cash: moneyNumber(cashSnap.cashBalance), orderable: moneyNumber(cashSnap.orderableAmount) }
        : null,
      accountSnapshot: accountSnap
        ? { total: moneyNumber(accountSnap.totalAssetValue), cash: moneyNumber(accountSnap.cashValue) }
        : null,
      reconRun: reconRun ? { status: reconRun.status } : null,
      dbDelta: Object.fromEntries(
        COUNT_TABLES.map((table) => [table, dbAfter[table] - dbBefore[table]]),
      ),
      sameIntentDidNotResubmit: http.counts.domesticOrderCash === submitAfter,
    });

    report.order = {
      intentId,
      odno,
      status: latest?.status,
      submit: brokerSubmitCount,
    };
    report.http = http.counts;
    report.dbBefore = dbBefore;
    report.dbAfter = dbAfter;
    report.jsonExecs = jsonExecs.length;
    report.rdsBuyHistory = buyForOdno.length;

    if (!odno) {
      outcome = "FAIL";
      blocked = "FAIL: no KIS ODNO";
      return;
    }
    if ((latest?.qty ?? 0) !== 1 && (latest?.orderedQty ?? latest?.qty) !== 1) {
      outcome = "FAIL";
      blocked = "FAIL: PAPER qty != 1";
      return;
    }

    const pending = latest?.status === "pending";
    if (pending || ((latest?.filledQty ?? 0) < 1 && latest?.status !== "filled")) {
      outcome = "INCOMPLETE";
      report.assessment = "CONDITIONAL PASS";
      appendVtsEvent(run.dir, { type: "conditional", odno, status: latest?.status });
      return;
    }

    const kisDelta = kisQtyAfter - kisQtyBefore;
    const jsonDelta = jsonQtyAfter - jsonQtyBefore;
    const rdsDelta = rdsQtyAfter - rdsTickerBefore;
    if (kisDelta !== jsonDelta || jsonDelta !== rdsDelta) {
      outcome = "FAIL";
      blocked = `FAIL: position delta KIS ${kisDelta} JSON ${jsonDelta} RDS ${rdsDelta}`;
      return;
    }
    if (!postDiff.matched) {
      outcome = "FAIL";
      blocked = `FAIL: post-reconciliation ${postDiff.reasons.join(" / ")}`;
      return;
    }
    if (buyForOdno.length < 1) {
      outcome = "FAIL";
      blocked = "FAIL: v_buy_history missing this BUY";
      return;
    }
    if (trades.items.some((row) => row.status === "CLOSED")) {
      outcome = "FAIL";
      blocked = "FAIL: trade CLOSED after BUY-only";
      return;
    }
  } catch (err) {
    outcome = "FAIL";
    blocked = err instanceof Error ? err.message : "gate failed";
    appendVtsEvent(run.dir, { type: "error", message: blocked });
  } finally {
    http.restore();
    report.blocked = blocked;
    report.outcome = outcome;
    report.httpFinal = http.counts;
    writeJson(run.dir, "gate-report.json", report);
    finishVtsTestRun(run, outcome, {
      blocked,
      http: http.counts,
      persistence: persistenceMode(),
    });
    const line = JSON.stringify({
      outcome,
      blocked,
      testRunId: run.testRunId,
      dir: run.dir,
      http: http.counts,
    });
    console.log(redactSecrets(line));
    resetDbClientForTest();
    process.exit(outcome === "PASS" || outcome === "INCOMPLETE" ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(redactSecrets(err instanceof Error ? err.message : "gate failed"));
  process.exit(1);
});
