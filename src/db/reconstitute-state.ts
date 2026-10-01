/**
 * Rebuild trading-book slices from DB ledger when JSON cache is missing.
 * Used by PERSISTENCE_MODE=database so restart recovery does not depend on state.json.
 *
 * Does not invent fills from positions-only rows. Fixture/mock provenance is not
 * promoted to live PAPER fills.
 */
import { createInitialState } from "@/lib/engine";
import type { AppState, Order, OrderIntent, OrderStatus, Position, Side } from "@/lib/types";
import { moneyNumber } from "@/src/db/money";
import type { Ledger } from "@/src/db/ledger";
import type { IntentRow, OrderRow, PositionRow } from "@/src/db/rows";
import { emptyCircuit } from "@/src/risk/circuit";
import { emptyStartupSync } from "@/src/runtime/startup-sync";

function mapDbSide(side: string): Side {
  return String(side).toUpperCase() === "SELL" ? "sell" : "buy";
}

function mapDbOrderStatus(status: string): OrderStatus {
  const s = String(status).toUpperCase();
  if (s === "FILLED") return "filled";
  if (s === "CANCELLED" || s === "CANCELED") return "cancelled";
  if (s === "REJECTED") return "rejected";
  if (s === "UNKNOWN") return "unknown";
  return "pending";
}

function mapDbIntentStatus(status: string): OrderIntent["status"] {
  const s = String(status).toUpperCase();
  if (s === "FILLED") return "filled";
  if (s === "CANCELLED" || s === "CANCELED") return "cancelled";
  if (s === "REJECTED") return "rejected";
  return "pending";
}

function orderFromRow(row: OrderRow, symbol: string): Order {
  const qty = moneyNumber(row.requestedQty);
  const price = moneyNumber(row.requestedPrice ?? "0");
  const filledQty = moneyNumber(row.filledQty);
  return {
    id: row.localOrderId,
    createdAt: row.createdAt,
    source: "rule",
    sourceId: row.sourceId ?? undefined,
    ruleId: row.ruleKey,
    code: symbol,
    name: symbol,
    side: mapDbSide(row.side),
    qty,
    price,
    amount: qty * price,
    commission: 0,
    tax: 0,
    net: filledQty * moneyNumber(row.averageFillPrice ?? row.requestedPrice ?? "0"),
    status: mapDbOrderStatus(row.status),
    brokerOrderNo: row.brokerOrderNo ?? undefined,
    intentId: row.intentId ?? undefined,
    reason: row.reason ?? undefined,
    filledQty: filledQty > 0 ? filledQty : undefined,
  };
}

function intentFromRow(row: IntentRow, symbol: string): OrderIntent {
  return {
    intentId: row.intentKey,
    signalId: row.intentKey,
    ruleId: row.ruleKey,
    ticker: symbol,
    side: mapDbSide(row.side),
    qty: moneyNumber(row.quantity),
    price: moneyNumber(row.referencePrice ?? "0"),
    createdAt: row.createdAt,
    reason: row.reason ?? "db-reconstitute",
    status: mapDbIntentStatus(row.status),
  };
}

function positionFromRow(row: PositionRow, symbol: string): Position {
  return {
    code: symbol,
    name: symbol,
    qty: moneyNumber(row.quantity),
    avgPrice: moneyNumber(row.averagePrice),
    ruleId: row.ruleScope || "cash",
  };
}

export async function reconstituteAppStateFromLedger(
  ledger: Ledger,
  brokerAccountId: string,
): Promise<AppState> {
  return ledger.transaction(async (tx) => {
    const [intentRows, orderRows, positionRows, accountState] = await Promise.all([
      tx.listIntentsByAccount(brokerAccountId),
      tx.listOrdersByAccount(brokerAccountId),
      tx.listPositions(brokerAccountId),
      tx.getTradingAccountState(brokerAccountId),
    ]);

    const symbolByInstrument = new Map<string, string>();
    async function symbolOf(instrumentId: string): Promise<string> {
      const cached = symbolByInstrument.get(instrumentId);
      if (cached) return cached;
      const instrument = await tx.getInstrument(instrumentId);
      const symbol = instrument?.symbol ?? instrumentId.slice(0, 8);
      symbolByInstrument.set(instrumentId, symbol);
      return symbol;
    }

    const intents: OrderIntent[] = [];
    for (const row of intentRows) {
      intents.push(intentFromRow(row, await symbolOf(row.instrumentId)));
    }

    const orders: Order[] = [];
    for (const row of orderRows) {
      orders.push(orderFromRow(row, await symbolOf(row.instrumentId)));
    }

    const positions: Position[] = [];
    for (const row of positionRows) {
      const qty = moneyNumber(row.quantity);
      if (qty <= 0) continue;
      positions.push(positionFromRow(row, await symbolOf(row.instrumentId)));
    }

    const base = createInitialState();
    base.intents = intents;
    base.orders = orders;
    base.positions = positions;
    base.cash = 0;
    base.totalDeposit = 0;
    base.allocations = base.allocations.map((row) => ({ ...row, budget: 0, balance: 0 }));
    base.dayStart = { date: base.dayStart.date, equity: 0 };
    base.equityHistory = [0];
    base.startupSync = emptyStartupSync();
    base.circuit = emptyCircuit();
    if (accountState?.circuitHalted) {
      base.circuit = {
        ...base.circuit,
        halted: true,
        kind: (accountState.circuitKind as AppState["circuit"]["kind"]) ?? undefined,
        reason: accountState.circuitReason ?? "Restored circuit from DB",
        unknownCount: accountState.unknownOrderCount ?? 0,
      };
    }
    if (accountState) {
      base.settings.autoTrading = Boolean(accountState.autoTradingEnabled);
      base.settings.onboardingComplete = Boolean(accountState.onboardingComplete);
      base.settings.liquidating = Boolean(accountState.liquidating);
    }
    base.updatedAt = new Date().toISOString();
    return base;
  });
}
