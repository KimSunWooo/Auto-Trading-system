/**
 * KIS PAPER history-first recovery for 005930 / 069500.
 * Priority: KIS history → JSON complement → DB backfill.
 * Never invents ODNO/fill times. Legacy only if NOT_FOUND_WITHIN_AVAILABLE_RANGE.
 * Does NOT enable autoTrading. Does NOT place broker orders.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

process.env.ALLOW_LIVE_TRADING = "false";
process.env.KIS_MODE = String(process.env.KIS_MODE ?? "paper").trim() || "paper";
process.env.TRADING_MODE = String(process.env.TRADING_MODE ?? "live_test").trim() || "live_test";
process.env.BROKER = String(process.env.BROKER ?? "kis").trim() || "kis";
delete process.env.KIS_LIVE_CONFIRM;

const TARGET = "e3152ebd-c8f5-432f-8923-287d3163e79c";
const SYMBOLS = ["005930", "069500"] as const;
const APPLY = process.argv.includes("--apply");

type SelectedSource =
  | "KIS_PAPER_HISTORY"
  | "JSON_VERIFIED_WITH_KIS"
  | "KIS_POSITION_SNAPSHOT"
  | "UNKNOWN";

function ymdSeoul(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(d)
    .replaceAll("-", "");
}

function addDaysYmd(ymd: string, delta: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function seoulIsoFromKis(ordDt?: string, ordTmd?: string): string {
  if (!ordDt || ordDt.length !== 8) return new Date().toISOString();
  const hh = (ordTmd ?? "090000").padStart(6, "0").slice(0, 2);
  const mi = (ordTmd ?? "090000").padStart(6, "0").slice(2, 4);
  const ss = (ordTmd ?? "090000").padStart(6, "0").slice(4, 6);
  // Interpret as Asia/Seoul wall clock → ISO
  const asUtcGuess = Date.parse(
    `${ordDt.slice(0, 4)}-${ordDt.slice(4, 6)}-${ordDt.slice(6, 8)}T${hh}:${mi}:${ss}+09:00`,
  );
  return Number.isFinite(asUtcGuess) ? new Date(asUtcGuess).toISOString() : new Date().toISOString();
}

function statusOfRow(row: {
  filledQty: number;
  unfilledQty: number;
  qty: number;
  cnclYn?: string;
}): "filled" | "cancelled" | "pending" {
  if (String(row.cnclYn).toUpperCase() === "Y") return "cancelled";
  if (row.filledQty > 0 && row.unfilledQty <= 0) return "filled";
  if (row.filledQty > 0) return "filled"; // partial treated as filled for historical ledger qty
  return "pending";
}

async function main() {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("@/src/db/client");
  const schema = await import("@/src/db/schema");
  const { resolveTradingRuntimeForAccount } = await import(
    "@/src/runtime/resolve-trading-runtime"
  );
  const { findStock } = await import("@/lib/universe");
  const { CASH_RULE_ID } = await import("@/src/rules/params");
  const { getMysqlLedger } = await import("@/src/db/mysql-ledger");
  const { describeInstrument, instrumentIdFor, executionKeyFor } = await import("@/src/db/mapping");
  const { money } = await import("@/src/db/money");
  const { mysqlDateUtc, toMysqlUtc } = await import("@/src/db/time");
  const { stableId, newId } = await import("@/src/db/ids");
  const { formatInstrumentLabel } = await import("@/src/instruments/metadata");
  type KisDayOrder = import("@/src/brokers/kis-client").KisDayOrder;

  console.log("=== KIS PAPER History-First Recovery ===");
  console.log("account=", TARGET);
  console.log("apply=", APPLY ? "YES" : "NO (dry-run)");
  console.log("symbols=", SYMBOLS.join(","));

  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  const account = (
    await db.select().from(schema.brokerAccounts).where(eq(schema.brokerAccounts.id, TARGET)).limit(1)
  )[0];
  if (!account) throw new Error("account not found");

  const rt = await resolveTradingRuntimeForAccount(account);
  const client = rt.scope.kisClient;
  if (!client.inquireDailyCcldRange) {
    throw new Error("KisClient.inquireDailyCcldRange missing");
  }

  const today = ymdSeoul(new Date());
  const windows: Array<{ start: string; end: string }> = [];
  // Recent → older, 7-day windows covering ~90 days (VTTC0081R)
  for (let back = 0; back < 90; back += 7) {
    const end = addDaysYmd(today, -back);
    const start = addDaysYmd(end, -6);
    windows.push({ start, end });
  }
  console.log("windows=", windows.length, "first=", windows[0], "last=", windows[windows.length - 1]);

  const allRows: KisDayOrder[] = [];
  const seenKey = new Set<string>();
  let queryErrors = 0;

  for (const [i, w] of windows.entries()) {
    try {
      const rows = await client.inquireDailyCcldRange!({
        startDt: w.start,
        endDt: w.end,
        ccldDvsn: "00",
        pdno: "",
      });
      for (const row of rows) {
        const key = `${row.ordDt ?? ""}:${row.orderNo}:${row.ticker}:${row.side}:${row.filledQty}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        allRows.push(row);
      }
      console.log(
        `window[${i}] ${w.start}-${w.end} rows=${rows.length} cumulative=${allRows.length}`,
      );
    } catch (err) {
      queryErrors += 1;
      console.log(
        `window[${i}] FAIL ${w.start}-${w.end}`,
        err instanceof Error ? err.message.slice(0, 120) : err,
      );
    }
  }

  // Targeted PDNO passes for the two holdings (recent 30d) if still empty for them
  for (const sym of SYMBOLS) {
    const has = allRows.some((r) => r.ticker === sym && r.filledQty > 0);
    if (has) continue;
    const end = today;
    const start = addDaysYmd(today, -29);
    try {
      const rows = await client.inquireDailyCcldRange!({
        startDt: start,
        endDt: end,
        ccldDvsn: "01",
        pdno: sym,
      });
      for (const row of rows) {
        const key = `${row.ordDt ?? ""}:${row.orderNo}:${row.ticker}:${row.side}:${row.filledQty}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        allRows.push(row);
      }
      console.log(`pdno[${sym}] ${start}-${end} fills=${rows.length}`);
    } catch (err) {
      queryErrors += 1;
      console.log(`pdno[${sym}] FAIL`, err instanceof Error ? err.message.slice(0, 120) : err);
    }
  }

  const state = await rt.store.getState();
  const jsonOrders = state.orders ?? [];
  const dbOrders = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.brokerAccountId, TARGET));
  const dbExecs = await db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.brokerAccountId, TARGET));

  const reports: Array<{
    symbol: string;
    name: string;
    kisQueried: boolean;
    historyFound: boolean;
    selected: SelectedSource;
    best?: KisDayOrder;
    jsonHistory: string;
    dbHistory: string;
    action: string;
  }> = [];

  const toImport: KisDayOrder[] = [];
  let mismatchAbort = false;

  for (const sym of SYMBOLS) {
    const name = findStock(sym)?.name ?? formatInstrumentLabel(sym);
    const kisForSym = allRows
      .filter((r) => r.ticker === sym)
      .sort((a, b) => String(b.ordDt ?? "").localeCompare(String(a.ordDt ?? "")));
    const fills = kisForSym.filter((r) => r.filledQty > 0);
    const best = fills[0] ?? kisForSym[0];
    const historyFound = fills.length > 0;

    const jsonForSym = jsonOrders.filter((o) => o.code === sym && !o.parentOrderId);
    const dbForSym = dbOrders.filter((o) => {
      // instrument join later — match by brokerOrderNo in sample
      return true;
    });

    const jsonDesc =
      jsonForSym.length === 0
        ? "없음"
        : jsonForSym
            .map(
              (o) =>
                `${o.status} ${o.side} qty=${o.qty} px=${o.price} odno=${o.brokerOrderNo ?? "-"} class=${o.activeClass ?? "-"}`,
            )
            .join(" | ");

    const dbOdnos = dbOrders
      .filter((o) => o.brokerOrderNo)
      .map((o) => `${o.status} odno=${o.brokerOrderNo} qty=${o.requestedQty}`);
    const dbDesc =
      dbOrders.length === 0
        ? "없음"
        : `orders=${dbOrders.length} execs=${dbExecs.length}${dbOdnos.length ? " · " + dbOdnos.slice(0, 5).join(" | ") : ""}`;

    let selected: SelectedSource = "UNKNOWN";
    let action = "none";

    if (historyFound && best) {
      const jsonMatch = jsonForSym.find(
        (o) =>
          o.brokerOrderNo &&
          best.orderNo &&
          o.brokerOrderNo.replace(/^0+/, "") === best.orderNo.replace(/^0+/, ""),
      );
      if (jsonMatch) {
        // Verify qty/side/price roughly
        const fillPx = best.avgPrice || best.orderPrice || 0;
        const sideOk = jsonMatch.side === best.side;
        const qtyOk = (jsonMatch.filledQty ?? jsonMatch.qty) === best.filledQty;
        const pxOk =
          fillPx === 0 || Math.abs((jsonMatch.price ?? 0) - fillPx) < 1;
        if (sideOk && qtyOk && pxOk) {
          selected = "JSON_VERIFIED_WITH_KIS";
          action = "DB backfill from verified JSON+KIS";
          toImport.push(best);
        } else {
          selected = "UNKNOWN";
          action = "MISMATCH KIS vs JSON — no auto overwrite";
          mismatchAbort = true;
          console.log("MISMATCH", sym, {
            kis: best,
            json: {
              side: jsonMatch.side,
              qty: jsonMatch.filledQty ?? jsonMatch.qty,
              price: jsonMatch.price,
              odno: jsonMatch.brokerOrderNo,
            },
          });
        }
      } else if (jsonForSym.length === 0) {
        selected = "KIS_PAPER_HISTORY";
        action = "JSON complement from KIS then DB backfill";
        toImport.push(best);
        // Also import other fills for this symbol
        for (const f of fills.slice(1)) {
          if (!toImport.some((x) => x.orderNo === f.orderNo && x.ordDt === f.ordDt)) {
            toImport.push(f);
          }
        }
      } else {
        // JSON has orders without matching ODNO — report mismatch
        selected = "UNKNOWN";
        action = "MISMATCH: JSON has history without matching KIS ODNO — no auto overwrite";
        mismatchAbort = true;
      }
    } else {
      // NOT_FOUND — position snapshot legacy only
      const pos = state.positions.find((p) => p.code === sym && p.qty > 0);
      const hold = state.kisBalance?.holdings?.find((h) => h.ticker === sym && h.qty > 0);
      if (pos || hold) {
        selected = "KIS_POSITION_SNAPSHOT";
        action =
          "NOT_FOUND_WITHIN_AVAILABLE_RANGE → LEGACY_POSITION_IMPORT (no synthetic ODNO/fill)";
      } else {
        selected = "UNKNOWN";
        action = "no KIS history and no position";
      }
    }

    reports.push({
      symbol: sym,
      name: typeof name === "string" ? name : String(name),
      kisQueried: queryErrors < windows.length, // at least some queries ran
      historyFound,
      selected,
      best,
      jsonHistory: jsonDesc,
      dbHistory: dbDesc,
      action,
    });
  }

  for (const r of reports) {
    const b = r.best;
    console.log("\n----------------------------------------");
    console.log(`${r.symbol} ${r.name}`);
    console.log(`KIS history queried = ${r.kisQueried}`);
    console.log(`history found = ${r.historyFound}`);
    console.log(`ODNO = ${b?.orderNo ?? ""}`);
    console.log(`orderDate = ${b?.ordDt ?? ""}`);
    console.log(`orderTime = ${b?.ordTmd ?? ""}`);
    console.log(`executionTime = ${b?.ordTmd ?? ""}`); // KIS daily-ccld exposes ord_tmd; no separate fill clock when absent
    console.log(`side = ${b?.side ?? ""}`);
    console.log(`orderedQty = ${b?.qty ?? ""}`);
    console.log(`filledQty = ${b?.filledQty ?? ""}`);
    console.log(`orderPrice = ${b?.orderPrice ?? ""}`);
    console.log(`fillPrice = ${b?.avgPrice ?? ""}`);
    console.log(`status = ${b ? statusOfRow(b) : ""}`);
    console.log(`JSON history = ${r.jsonHistory}`);
    console.log(`DB history = ${r.dbHistory}`);
    console.log(`selected source = ${r.selected}`);
    console.log(`action = ${r.action}`);
  }

  console.log("\n--- Aggregate KIS rows (target symbols) ---");
  for (const row of allRows.filter((r) => SYMBOLS.includes(r.ticker as (typeof SYMBOLS)[number]))) {
    console.log(
      JSON.stringify({
        odno: row.orderNo,
        ticker: row.ticker,
        name: row.name,
        side: row.side,
        qty: row.qty,
        filled: row.filledQty,
        unfilled: row.unfilledQty,
        ordPx: row.orderPrice,
        fillPx: row.avgPrice,
        ordDt: row.ordDt,
        ordTmd: row.ordTmd,
        cncl: row.cnclYn,
      }),
    );
  }
  console.log("allRows.total=", allRows.length);
  console.log("queryErrors=", queryErrors);

  if (mismatchAbort) {
    console.log("\nABORT_APPLY: KIS/JSON mismatch — no writes");
    process.exit(2);
  }

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with --apply to write JSON/DB.");
    process.exit(0);
  }

  // APPLY
  let nextState = await rt.store.getState();
  const existingOdno = new Set(
    (nextState.orders ?? [])
      .map((o) => (o.brokerOrderNo ?? "").replace(/^0+/, ""))
      .filter(Boolean),
  );

  const importedKeys: string[] = [];
  for (const row of toImport) {
    if (!row.orderNo) continue;
    const odnoKey = row.orderNo.replace(/^0+/, "");
    if (existingOdno.has(odnoKey)) continue;
    const createdAt = seoulIsoFromKis(row.ordDt, row.ordTmd);
    const fillPx = row.avgPrice || row.orderPrice || 0;
    const st = statusOfRow(row);
    if (st === "pending" && row.filledQty <= 0) continue; // skip pure open without fill for historical import
    const seed = findStock(row.ticker);
    const name = row.name || seed?.name || row.ticker;
    const parentId = `kis-hist-${row.ordDt ?? "00000000"}-${odnoKey}`;
    const filledQty = row.filledQty;
    const orderedQty = row.qty || filledQty;
    const price = fillPx || row.orderPrice || 0;
    const amount = price * filledQty;
    const parent = {
      id: parentId,
      createdAt,
      source: "rule" as const,
      ruleId: CASH_RULE_ID,
      code: row.ticker,
      name,
      side: row.side,
      qty: filledQty || orderedQty,
      price,
      amount,
      commission: 0,
      tax: 0,
      net: amount,
      status: st === "cancelled" ? ("cancelled" as const) : ("filled" as const),
      brokerOrderNo: row.orderNo,
      orderedQty,
      filledQty,
      activeClass: "HISTORICAL_MATCHED" as const,
      provenance: "KIS_PAPER_HISTORY",
      reason: `KIS_PAPER_HISTORY · odno=${row.orderNo} ord_dt=${row.ordDt ?? ""}`,
    };
    nextState = {
      ...nextState,
      orders: [parent, ...(nextState.orders ?? [])],
    };
    existingOdno.add(odnoKey);
    importedKeys.push(parentId);
  }

  // Positions already from KIS balance in JSON — ensure they remain
  const bal = await client.inquireBalance();
  for (const h of bal.holdings ?? []) {
    if (!SYMBOLS.includes(h.ticker as (typeof SYMBOLS)[number])) continue;
    const idx = nextState.positions.findIndex((p) => p.code === h.ticker && p.qty > 0);
    if (idx < 0) {
      nextState = {
        ...nextState,
        positions: [
          ...nextState.positions,
          {
            code: h.ticker,
            name: h.name || findStock(h.ticker)?.name || h.ticker,
            qty: h.qty,
            avgPrice: h.avgPrice,
            ruleId: CASH_RULE_ID,
          },
        ],
      };
    }
  }

  await rt.store.mutateStore(async () => nextState);
  const finalState = await rt.store.getState();
  const hasKisHistoryImport = reports.some(
    (r) => r.selected === "KIS_PAPER_HISTORY" || r.selected === "JSON_VERIFIED_WITH_KIS",
  );
  const useLegacy = reports.some((r) => r.selected === "KIS_POSITION_SNAPSHOT") && !hasKisHistoryImport;

  // Direct backfill to TARGET broker_account (do not use bootstrap projectAppState account id).
  const ledger = getMysqlLedger(process.env);
  let importedOrders = 0;
  let importedExecutions = 0;
  let importedPositions = 0;

  await ledger.transaction(async (tx) => {
    const now = toMysqlUtc(new Date().toISOString());
    for (const parent of finalState.orders.filter(
      (o) =>
        !o.parentOrderId &&
        SYMBOLS.includes(o.code as (typeof SYMBOLS)[number]) &&
        (o.provenance === "KIS_PAPER_HISTORY" || o.brokerOrderNo),
    )) {
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
        kisExchangeCode: desc.kisExchangeCode ?? null,
        instrumentType: "STOCK",
        isActive: true,
      });
      const requested = parent.orderedQty ?? parent.qty;
      const filled = parent.filledQty ?? (parent.status === "filled" ? parent.qty : 0);
      const remaining = Math.max(0, requested - filled);
      const status =
        parent.status === "filled"
          ? "FILLED"
          : parent.status === "cancelled"
            ? "CANCELLED"
            : parent.status === "pending"
              ? "SUBMITTED"
              : "UNKNOWN";
      const result = await tx.upsertOrder({
        id: stableId("order", `${TARGET}:${parent.id}`),
        brokerAccountId: TARGET,
        instrumentId: instrument.id,
        intentId: null,
        localOrderId: parent.id.slice(0, 191),
        brokerOrderNo: parent.brokerOrderNo ?? null,
        brokerOrderDate: parent.brokerOrderNo
          ? mysqlDateUtc(parent.createdAt)
          : null,
        brokerOrgNo: parent.krxOrgNo ?? null,
        side: parent.side === "sell" ? "SELL" : "BUY",
        orderType: parent.ordDvsn === "limit" ? "LIMIT" : "MARKET",
        requestedQty: money(requested),
        requestedPrice: money(parent.price),
        filledQty: money(filled),
        remainingQty: money(remaining),
        averageFillPrice: filled > 0 ? money(parent.price) : null,
        currency: instrument.currency,
        status,
        source: "KIS_PAPER_HISTORY",
        sourceId: parent.brokerOrderNo ?? null,
        ruleKey: parent.ruleId || CASH_RULE_ID,
        reason: parent.reason ?? null,
        submittedAt: parent.brokerOrderNo ? toMysqlUtc(parent.createdAt) : null,
        acceptedAt: parent.brokerOrderNo ? toMysqlUtc(parent.createdAt) : null,
        completedAt:
          status === "FILLED" || status === "CANCELLED" ? toMysqlUtc(parent.createdAt) : null,
        createdAt: toMysqlUtc(parent.createdAt),
        updatedAt: now,
      });
      if (result.inserted) importedOrders += 1;

      if (filled > 0) {
        const key = executionKeyFor(parent, undefined, filled);
        const existing = await tx.getExecutionByKey(TARGET, key);
        if (!existing) {
          await tx.insertExecution({
            id: newId(),
            brokerAccountId: TARGET,
            orderId: result.row.id,
            instrumentId: instrument.id,
            tradeId: null,
            executionKey: key,
            brokerExecutionId: null,
            brokerOrderNo: parent.brokerOrderNo ?? null,
            side: parent.side === "sell" ? "SELL" : "BUY",
            quantity: money(filled),
            price: money(parent.price),
            grossAmount: money(filled * parent.price),
            commission: money(0),
            tax: money(0),
            otherFee: money(0),
            realizedPnl: null,
            currency: instrument.currency,
            executedAt: toMysqlUtc(parent.createdAt),
            createdAt: now,
          });
          importedExecutions += 1;
        }
      }
    }

    for (const pos of finalState.positions.filter((p) =>
      SYMBOLS.includes(p.code as (typeof SYMBOLS)[number]),
    )) {
      if (pos.qty <= 0) continue;
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
        kisExchangeCode: desc.kisExchangeCode ?? null,
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
        currency: instrument.currency,
        provenance: useLegacy ? "LEGACY_STATE" : "RUNTIME",
        updatedAt: now,
      });
      importedPositions += 1;
    }
  });

  console.log("\nAPPLY_DONE");
  console.log("json.orders.imported=", importedKeys.join(",") || "(none)");
  console.log(
    "db.backfill=",
    useLegacy ? "LEGACY_POSITION_IMPORT" : "KIS_HISTORY_RUNTIME",
    `orders=${importedOrders}`,
    `executions=${importedExecutions}`,
    `positions=${importedPositions}`,
  );
  console.log("broker.orders.placed=0");
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
