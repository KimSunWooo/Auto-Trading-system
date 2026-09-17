/**
 * Read-only domestic PAPER balance/reconciliation remirror.
 * Never BUY/SELL/CANCEL/FLATTEN. Never enables order-test env flags.
 */
import { existsSync, readFileSync } from "node:fs";
import { persistStateNow, DEFAULT_STORE_PATH } from "@/lib/store";
import type { AppState, Order } from "@/lib/types";
import { KisClient, sameOdno } from "@/src/brokers/kis-client";
import { loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { dbConfigured, persistenceMode } from "@/src/db/config";
import { loadLocalEnv } from "@/src/db/load-env";
import { getMysqlLedger } from "@/src/db/mysql-ledger";
import { projectAppState } from "@/src/db/projector";
import { moneyNumber } from "@/src/db/money";
import { refreshBrokerBalanceSnapshot } from "@/src/risk/balance-sync";

const TICKER = "005930";
const ODNO = "0000022105";

type HttpCounts = {
  paperHost: number;
  realHost: number;
  domesticOrderCash: number;
  domesticCancel: number;
  overseasOrder: number;
};

function abortIfOrderTestsEnabled() {
  if (process.env.RUN_KIS_VTS_ORDER_TESTS === "true") {
    throw new Error("Refuse: RUN_KIS_VTS_ORDER_TESTS must stay off");
  }
  if (process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS === "true") {
    throw new Error("Refuse: RUN_KIS_VTS_OVERSEAS_ORDER_TESTS must stay off");
  }
  if (process.env.ALLOW_LIVE_TRADING === "true") {
    throw new Error("Refuse: ALLOW_LIVE_TRADING must stay off");
  }
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
    if (pathOnly.includes("/uapi/domestic-stock/v1/trading/order-cash")) {
      counts.domesticOrderCash += 1;
      throw new Error("BLOCKED: domestic order-cash is forbidden in this audit");
    }
    if (pathOnly.includes("/uapi/domestic-stock/v1/trading/order-rvsecncl")) {
      counts.domesticCancel += 1;
      throw new Error("BLOCKED: cancel is forbidden in this audit");
    }
    if (pathOnly.includes("/uapi/overseas-stock/v1/trading/order")) {
      counts.overseasOrder += 1;
      throw new Error("BLOCKED: overseas order is forbidden in this audit");
    }
    return orig(input as RequestInfo, init);
  }) as typeof fetch;
  return { counts, restore: () => { globalThis.fetch = orig; } };
}

function padTicker(code: string): string {
  return code.replace(/\D/g, "").slice(-6).padStart(6, "0");
}

function qtyOf(rows: Array<{ code?: string; ticker?: string; qty: number }>, ticker: string): number {
  const code = padTicker(ticker);
  return rows
    .filter((row) => padTicker(String(row.code ?? row.ticker ?? "")) === code)
    .reduce((sum, row) => sum + row.qty, 0);
}

function keepExistingTradeOrders(orders: Order[]): Order[] {
  return orders.filter((order) => {
    if (sameOdno(order.brokerOrderNo, ODNO)) return true;
    if (order.parentOrderId) {
      const parent = orders.find((row) => row.id === order.parentOrderId);
      return sameOdno(parent?.brokerOrderNo, ODNO);
    }
    return false;
  });
}

async function main() {
  loadLocalEnv();
  abortIfOrderTestsEnabled();
  process.env.BROKER = "kis";
  if (!process.env.KIS_MODE) process.env.KIS_MODE = "paper";
  process.env.ALLOW_LIVE_TRADING = "false";
  delete process.env.KIS_LIVE_CONFIRM;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;

  const mode = resolveKisEnvironment();
  if (mode !== "paper") {
    throw new Error(`Refuse: KIS environment is ${mode}, paper only`);
  }

  const http = installHttpGuard();
  try {
    const cfg = loadKisConfig();
    const client = new KisClient(cfg);
    if (!client.configured) {
      throw new Error(client.issues[0] ?? "KIS PAPER is not configured");
    }

    const quote = await client.inquirePrice(TICKER);
    const balance = await client.inquireBalance();
    let psbl: Awaited<ReturnType<KisClient["inquirePsblOrder"]>> | undefined;
    try {
      psbl = await client.inquirePsblOrder({ ticker: TICKER, price: quote.price });
    } catch (err) {
      console.error("inquire-psbl-order failed:", err instanceof Error ? err.message : err);
    }
    const ccld = await client.inquireDailyCcld();
    const open = await client.inquireOpenOrders();
    const fill = ccld.find((row) => sameOdno(row.orderNo, ODNO));

    if (!existsSync(DEFAULT_STORE_PATH)) {
      throw new Error(`JSON ledger missing: ${DEFAULT_STORE_PATH}`);
    }
    const state = JSON.parse(readFileSync(DEFAULT_STORE_PATH, "utf8")) as AppState;
    const box = { current: state };
    const refreshed = await refreshBrokerBalanceSnapshot(box, client);
    if (!refreshed.ok) {
      console.error("broker refresh failed:", refreshed.error);
    }

    const prevMode = process.env.PERSISTENCE_MODE;
    process.env.PERSISTENCE_MODE = "json";
    await persistStateNow(box.current);
    process.env.PERSISTENCE_MODE = prevMode;

    let rds: Record<string, unknown> | null = null;
    if (dbConfigured()) {
      process.env.PERSISTENCE_MODE = "mirror";
      const ledger = getMysqlLedger();
      const mirrorState: AppState = {
        ...box.current,
        orders: keepExistingTradeOrders(box.current.orders),
      };
      await projectAppState(ledger, mirrorState, { env: process.env, provenance: "RUNTIME" });
      const accounts = await ledger.transaction((tx) => tx.listBrokerAccounts());
      const paper = accounts.find((row) => row.environment === "PAPER") ?? accounts[0];
      if (paper) {
        const positions = await ledger.transaction((tx) => tx.listPositions(paper.id));
        const posDetailed = await Promise.all(
          positions.map(async (row) => ({
            row,
            instrument: await ledger.transaction((tx) => tx.getInstrument(row.instrumentId)),
          })),
        );
        const rdsQty = posDetailed
          .filter((row) => row.instrument?.symbol === TICKER)
          .reduce((sum, row) => sum + moneyNumber(row.row.quantity), 0);
        const buys = await ledger.transaction((tx) =>
          tx.listBuyHistory({ account: paper.id, symbol: TICKER, limit: 20 }),
        );
        const odnoBuys = buys.items.filter((row) => sameOdno(row.brokerOrderNo, ODNO));
        const trades = await ledger.transaction((tx) =>
          tx.listTrades({ account: paper.id, symbol: TICKER, limit: 20 }),
        );
        const cashSnap = await ledger.transaction((tx) => tx.lastCashSnapshot(paper.id, "KRW"));
        const accountSnap = await ledger.transaction((tx) => tx.lastAccountSnapshot(paper.id));
        const recon = await ledger.transaction((tx) => tx.lastReconRun(paper.id));
        const intent = (box.current.intents ?? []).find((row) => sameOdno(row.brokerOrderNo, ODNO));
        const intentRow = intent
          ? await ledger.transaction((tx) => tx.getIntentByKey(paper.id, intent.intentId.slice(0, 191)))
          : undefined;
        rds = {
          qty: rdsQty,
          buyHistoryOdno: odnoBuys.length,
          tradeStatus: trades.items[0]?.status ?? null,
          tradeCount: trades.items.length,
          cashBalance: cashSnap ? moneyNumber(cashSnap.cashBalance) : null,
          orderableAmount: cashSnap ? moneyNumber(cashSnap.orderableAmount) : null,
          accountCashValue: accountSnap ? moneyNumber(accountSnap.cashValue) : null,
          reconStatus: recon?.status ?? null,
          intentStatus: intentRow?.status ?? null,
          persistenceMode: persistenceMode(),
        };
      }
    }

    const jsonQty = qtyOf(box.current.positions, TICKER);
    const kisQty = qtyOf(balance.holdings, TICKER);
    const jsonExecs = box.current.orders.filter(
      (row) => sameOdno(row.brokerOrderNo, ODNO) && row.status === "filled" && Boolean(row.parentOrderId),
    );
    const openBuy = open.filter((row) => row.side === "buy" && padTicker(row.ticker) === TICKER);

    console.log(`Domestic PAPER Balance Semantics

Local Ledger
------------
runtimeCash:
${box.current.cash}

KIS inquire-balance
-------------------
dnca_tot_amt:
${balance.cash}

nxdy_excc_amt:
${balance.nxdyExccAmt ?? ""}

prvs_rcdl_excc_amt:
${balance.d2Cash}

thdt_buy_amt:
${balance.thdtBuyAmt ?? ""}

thdt_tlex_amt:
${balance.thdtTlexAmt ?? ""}

KIS inquire-psbl-order
----------------------
ord_psbl_cash:
${psbl?.orderableCash ?? ""}

nrcvb_buy_amt:
${psbl?.nrcvbBuyAmt ?? ""}

nrcvb_buy_qty:
${psbl?.nrcvbBuyQty ?? ""}

max_buy_amt:
${psbl?.maxBuyAmt ?? ""}

max_buy_qty:
${psbl?.maxBuyQty ?? ""}
`);
    console.log(
      JSON.stringify(
        {
          http: http.counts,
          position: { kis: kisQty, json: jsonQty, rds: rds?.qty ?? null },
          odno: {
            fill: fill
              ? { orderNo: fill.orderNo, qty: fill.qty, filledQty: fill.filledQty, avgPrice: fill.avgPrice }
              : null,
            jsonChildExecs: jsonExecs.length,
            openBuy: openBuy.map((row) => ({ orderNo: row.orderNo, unfilled: row.unfilledQty })),
          },
          kisBalance: box.current.kisBalance
            ? {
                cash: box.current.kisBalance.cash,
                orderableCash: box.current.kisBalance.orderableCash,
                d2Cash: box.current.kisBalance.d2Cash,
                matched: box.current.kisBalance.matched,
                freshness: box.current.kisBalance.freshness,
                message: box.current.kisBalance.message,
              }
            : null,
          rds,
          refreshOk: refreshed.ok,
        },
        null,
        2,
      ),
    );
  } finally {
    http.restore();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
