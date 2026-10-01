/**
 * Apply-only: write known KIS PAPER history into JSON + TARGET DB.
 * Uses verified ODNO rows from inquire-daily-ccld (no synthetic fills).
 * Does not place broker orders. Next worker must be stopped to avoid overwrite.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

process.env.ALLOW_LIVE_TRADING = "false";
process.env.KIS_MODE = "paper";
process.env.TRADING_MODE = "live_test";
process.env.BROKER = "kis";
delete process.env.KIS_LIVE_CONFIRM;

const TARGET = "e3152ebd-c8f5-432f-8923-287d3163e79c";

/** Verified from KIS inquire-daily-ccld (PDNO filter, 20260902–20261001). */
const KIS_FILLS = [
  {
    orderNo: "0000022105",
    ticker: "005930",
    name: "삼성전자",
    side: "buy" as const,
    qty: 1,
    filledQty: 1,
    unfilledQty: 0,
    orderPrice: 261000,
    avgPrice: 253500,
    ordDt: "20260917",
    ordTmd: "121404",
    cnclYn: "N",
  },
  {
    orderNo: "0000032626",
    ticker: "069500",
    name: "KODEX 200",
    side: "buy" as const,
    qty: 1,
    filledQty: 1,
    unfilledQty: 0,
    orderPrice: 109500,
    avgPrice: 106245,
    ordDt: "20260917",
    ordTmd: "151930",
    cnclYn: "N",
  },
];

function seoulIsoFromKis(ordDt: string, ordTmd: string): string {
  const hh = ordTmd.padStart(6, "0").slice(0, 2);
  const mi = ordTmd.padStart(6, "0").slice(2, 4);
  const ss = ordTmd.padStart(6, "0").slice(4, 6);
  const ms = Date.parse(
    `${ordDt.slice(0, 4)}-${ordDt.slice(4, 6)}-${ordDt.slice(6, 8)}T${hh}:${mi}:${ss}+09:00`,
  );
  return new Date(ms).toISOString();
}

async function main() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("@/src/db/client");
  const schema = await import("@/src/db/schema");
  const { CASH_RULE_ID } = await import("@/src/rules/params");
  const { getMysqlLedger } = await import("@/src/db/mysql-ledger");
  const { describeInstrument, instrumentIdFor, executionKeyFor } = await import(
    "@/src/db/mapping"
  );
  const { money } = await import("@/src/db/money");
  const { mysqlDateUtc, toMysqlUtc } = await import("@/src/db/time");
  const { stableId, newId } = await import("@/src/db/ids");
  type Order = import("@/lib/types").Order;
  type AppState = import("@/lib/types").AppState;

  const statePath = path.join(
    process.cwd(),
    "data/accounts",
    TARGET,
    "state.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as AppState;
  const existing = new Set(
    (state.orders ?? [])
      .map((o) => (o.brokerOrderNo ?? "").replace(/^0+/, ""))
      .filter(Boolean),
  );

  const added: Order[] = [];
  for (const row of KIS_FILLS) {
    const odnoKey = row.orderNo.replace(/^0+/, "");
    if (existing.has(odnoKey)) {
      console.log("skip existing odno", row.orderNo);
      continue;
    }
    const createdAt = seoulIsoFromKis(row.ordDt, row.ordTmd);
    const parent: Order = {
      id: `kis-hist-${row.ordDt}-${odnoKey}`,
      createdAt,
      source: "rule",
      ruleId: CASH_RULE_ID,
      code: row.ticker,
      name: row.name,
      side: row.side,
      qty: row.filledQty,
      price: row.avgPrice,
      amount: row.avgPrice * row.filledQty,
      commission: 0,
      tax: 0,
      net: row.avgPrice * row.filledQty,
      status: "filled",
      brokerOrderNo: row.orderNo,
      orderedQty: row.qty,
      filledQty: row.filledQty,
      activeClass: "HISTORICAL_MATCHED",
      provenance: "KIS_PAPER_HISTORY",
      reason: `KIS_PAPER_HISTORY · odno=${row.orderNo} ord_dt=${row.ordDt} ord_tmd=${row.ordTmd}`,
    };
    added.push(parent);
    existing.add(odnoKey);
  }

  const next: AppState = {
    ...state,
    orders: [...added, ...(state.orders ?? [])],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log("json.wrote", statePath, "added", added.map((o) => o.id).join(","));

  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  const account = (
    await db.select().from(schema.brokerAccounts).where(eq(schema.brokerAccounts.id, TARGET)).limit(1)
  )[0];
  if (!account) throw new Error("account missing");

  const ledger = getMysqlLedger(process.env);
  let importedOrders = 0;
  let importedExecutions = 0;
  let importedPositions = 0;
  const now = toMysqlUtc(new Date().toISOString());

  await ledger.transaction(async (tx) => {
    for (const parent of added) {
      const desc = describeInstrument(parent.code);
      const instrument = await tx.upsertInstrument({
        id: instrumentIdFor(parent.code),
        country: desc.country,
        market: desc.market,
        symbol: desc.symbol,
        displayName: parent.name || desc.displayName,
        koreanName: parent.name || desc.displayName,
        englishName: null,
        currency: desc.currency,
        kisExchangeCode: desc.kisExchangeCode,
        instrumentType: "STOCK",
        isActive: true,
      });
      const requested = parent.orderedQty ?? parent.qty;
      const filled = parent.filledQty ?? parent.qty;
      const result = await tx.upsertOrder({
        id: stableId("order", `${TARGET}:${parent.id}`),
        brokerAccountId: TARGET,
        instrumentId: instrument.id,
        intentId: null,
        localOrderId: parent.id.slice(0, 191),
        brokerOrderNo: parent.brokerOrderNo ?? null,
        brokerOrderDate: mysqlDateUtc(parent.createdAt),
        brokerOrgNo: null,
        side: "BUY",
        orderType: "LIMIT",
        requestedQty: money(requested),
        requestedPrice: money(parent.price),
        filledQty: money(filled),
        remainingQty: money(0),
        averageFillPrice: money(parent.price),
        currency: "KRW",
        status: "FILLED",
        source: "KIS_PAPER_HISTORY",
        sourceId: parent.brokerOrderNo ?? null,
        ruleKey: CASH_RULE_ID,
        reason: parent.reason ?? null,
        submittedAt: toMysqlUtc(parent.createdAt),
        acceptedAt: toMysqlUtc(parent.createdAt),
        completedAt: toMysqlUtc(parent.createdAt),
        createdAt: toMysqlUtc(parent.createdAt),
        updatedAt: now,
      });
      if (result.inserted) importedOrders += 1;

      const key = executionKeyFor(parent, undefined, filled);
      const existingExec = await tx.getExecutionByKey(TARGET, key);
      if (!existingExec) {
        await tx.insertExecution({
          id: newId(),
          brokerAccountId: TARGET,
          orderId: result.row.id,
          instrumentId: instrument.id,
          tradeId: null,
          executionKey: key,
          brokerExecutionId: null,
          brokerOrderNo: parent.brokerOrderNo ?? null,
          side: "BUY",
          quantity: money(filled),
          price: money(parent.price),
          grossAmount: money(filled * parent.price),
          commission: money(0),
          tax: money(0),
          otherFee: money(0),
          realizedPnl: null,
          currency: "KRW",
          executedAt: toMysqlUtc(parent.createdAt),
          createdAt: now,
        });
        importedExecutions += 1;
      }
    }

    for (const pos of next.positions.filter((p) => p.qty > 0)) {
      if (pos.code !== "005930" && pos.code !== "069500") continue;
      const desc = describeInstrument(pos.code);
      const instrument = await tx.upsertInstrument({
        id: instrumentIdFor(pos.code),
        country: desc.country,
        market: desc.market,
        symbol: desc.symbol,
        displayName: pos.name || desc.displayName,
        koreanName: pos.name || desc.displayName,
        englishName: null,
        currency: desc.currency,
        kisExchangeCode: desc.kisExchangeCode,
        instrumentType: "STOCK",
        isActive: true,
      });
      await tx.upsertPosition({
        id: stableId("position", `${TARGET}:${instrument.id}:${pos.ruleId || CASH_RULE_ID}`),
        brokerAccountId: TARGET,
        instrumentId: instrument.id,
        ruleScope: pos.ruleId || CASH_RULE_ID,
        quantity: money(pos.qty),
        availableQuantity: money(pos.qty),
        averagePrice: money(pos.avgPrice),
        totalCost: money(pos.qty * pos.avgPrice),
        marketPrice: money(pos.avgPrice),
        marketValue: money(pos.qty * pos.avgPrice),
        unrealizedPnl: money(0),
        unrealizedReturnPct: null,
        currency: "KRW",
        provenance: "RUNTIME",
        updatedAt: now,
      });
      importedPositions += 1;
    }
  });

  // verify JSON
  const verify = JSON.parse(fs.readFileSync(statePath, "utf8")) as AppState;
  console.log(
    "json.verify.orders=",
    verify.orders
      ?.filter((o) => !o.parentOrderId)
      .map((o) => `${o.code}:${o.brokerOrderNo}:${o.price}:${o.provenance}`)
      .join(" | "),
  );

  const orders = await db.select().from(schema.orders).where(eq(schema.orders.brokerAccountId, TARGET));
  const execs = await db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.brokerAccountId, TARGET));
  const pos = await db.select().from(schema.positions).where(eq(schema.positions.brokerAccountId, TARGET));
  console.log("db.orders=", orders.length, "execs=", execs.length, "pos=", pos.length);
  console.log(
    "db.odnos=",
    orders.map((o) => o.brokerOrderNo).join(","),
  );
  console.log("imported", { importedOrders, importedExecutions, importedPositions });
  console.log("selected source = KIS_PAPER_HISTORY");
  console.log("broker.orders.placed=0");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
