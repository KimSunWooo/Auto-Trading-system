import type { AppState, Order, OrderIntent } from "@/lib/types";
import { sameOdno } from "@/src/brokers/kis-client";
import type {
  OverseasExecution,
  OverseasOpenOrder,
  OverseasPosition,
  OverseasQuote,
} from "@/src/markets/overseas/types";
import { overseasIdentity, type OverseasInstrument } from "@/src/markets/overseas/instruments";

/** First live PAPER lifecycle uses exactly one share. Separate from domestic operational max=5. */
export const OVERSEAS_FIRST_LIFECYCLE_QTY = 1;

export type OverseasQuoteOrderableGate =
  | { ok: true; mode: "explicit_true" | "null_resolved" }
  | { ok: false; blocked: string; mode: "explicit_false" | "quote_unhealthy" | "market_closed" };

/**
 * Activation quote gate.
 * - orderable === false → BLOCK
 * - orderable === true → PASS (with market open + kis source)
 * - orderable === null → REVIEW via marketStatus + price (fail-safe, not clock-only)
 */
export function overseasQuoteOrderableGate(quote: OverseasQuote | null | undefined): OverseasQuoteOrderableGate {
  if (!quote || quote.source !== "kis" || !(quote.price > 0)) {
    return { ok: false, blocked: "Overseas quote unhealthy", mode: "quote_unhealthy" };
  }
  if (quote.marketStatus === "closed") {
    return { ok: false, blocked: "US market is not open", mode: "market_closed" };
  }
  if (quote.orderable === false) {
    return { ok: false, blocked: "Quote orderable=false", mode: "explicit_false" };
  }
  if (quote.orderable === true) {
    if (quote.marketStatus !== "open") {
      return { ok: false, blocked: "US market is not open", mode: "market_closed" };
    }
    return { ok: true, mode: "explicit_true" };
  }
  // orderable === null: require marketStatus open from KIS-derived semantics
  if (quote.marketStatus !== "open") {
    return {
      ok: false,
      blocked: "Quote orderable=null and marketStatus is not open — REVIEW",
      mode: "market_closed",
    };
  }
  return { ok: true, mode: "null_resolved" };
}

export function overseasFirstLifecycleQtyOk(qty: number): { ok: boolean; blocked: string | null } {
  if (!Number.isInteger(qty) || qty !== OVERSEAS_FIRST_LIFECYCLE_QTY) {
    return {
      ok: false,
      blocked: `ORDER TEST BLOCKED: Overseas first PAPER lifecycle qty must be ${OVERSEAS_FIRST_LIFECYCLE_QTY}`,
    };
  }
  return { ok: true, blocked: null };
}

export function overseasSellQtyAllowed(input: {
  qty: number;
  identity: string;
  kisPositions: OverseasPosition[];
  localPositions?: Array<{ code: string; qty: number }>;
}): { ok: boolean; blocked: string | null; available: number } {
  const symbol = input.identity.includes(":") ? input.identity.split(":")[1]! : input.identity;
  const kisQty = input.kisPositions
    .filter((row) => row.identity === input.identity || row.instrument.symbol === symbol)
    .reduce((sum, row) => sum + row.qty, 0);
  const localQty = (input.localPositions ?? [])
    .filter((row) => row.code === input.identity || row.code === symbol)
    .reduce((sum, row) => sum + row.qty, 0);
  const available =
    input.localPositions && input.localPositions.length > 0 ? Math.min(kisQty, localQty) : kisQty;
  if (input.qty < 1) {
    return { ok: false, blocked: "SELL qty < 1", available };
  }
  if (input.qty > available) {
    return {
      ok: false,
      blocked: "SELL qty exceeds KIS/local overseas holding",
      available,
    };
  }
  return { ok: true, blocked: null, available };
}

export function overseasCancelAllowed(input: {
  orderNo: string;
  instrument: OverseasInstrument;
  qty: number;
  openOrders: OverseasOpenOrder[];
  localOrder?: Pick<Order, "status" | "brokerOrderNo" | "code"> | null;
}): { ok: boolean; blocked: string | null } {
  if (!input.orderNo?.trim()) {
    return { ok: false, blocked: "Cancel requires exact ODNO" };
  }
  if (input.localOrder) {
    if (
      input.localOrder.status === "filled" ||
      input.localOrder.status === "cancelled" ||
      input.localOrder.status === "rejected"
    ) {
      return { ok: false, blocked: "Terminal order cannot be cancelled" };
    }
    if (input.localOrder.status === "unknown" && !input.localOrder.brokerOrderNo) {
      return { ok: false, blocked: "UNKNOWN without ODNO cannot be cancelled" };
    }
  }
  const identity = overseasIdentity(input.instrument.exchange, input.instrument.symbol);
  const match = input.openOrders.find(
    (row) =>
      sameOdno(row.orderNo, input.orderNo) &&
      row.identity === identity &&
      row.remainingQty > 0,
  );
  if (!match) {
    return { ok: false, blocked: "Exact ODNO not found in open orders" };
  }
  if (input.qty > match.remainingQty) {
    return { ok: false, blocked: "Cancel qty exceeds remaining" };
  }
  return { ok: true, blocked: null };
}

export type OverseasRecoveryClass =
  | "HEALTHY"
  | "ACTIVE_MATCHED"
  | "EXECUTION_MATCHED"
  | "UNKNOWN_BLOCKING"
  | "REMOTE_ONLY"
  | "MISMATCH";

export type OverseasRecoveryResult = {
  status: OverseasRecoveryClass;
  blocksNewBuy: boolean;
  message: string;
  matchedOdno?: string;
};

function isOverseasLocalOrder(order: Order): boolean {
  return (
    order.code.includes(":") ||
    Boolean(order.intentId?.includes("overseas")) ||
    Boolean(order.ruleId === "overseas")
  );
}

/**
 * Broker current state is authority. Local is history/operational.
 * Never ignores remote open orders; never blind-retries UNKNOWN.
 */
export function classifyOverseasRestart(input: {
  localIntents?: OrderIntent[];
  localOrders: Order[];
  openOrders: OverseasOpenOrder[];
  executions: OverseasExecution[];
}): OverseasRecoveryResult {
  const intents = input.localIntents ?? [];
  const pendingOrUnknown = input.localOrders.filter(
    (o) => isOverseasLocalOrder(o) && (o.status === "pending" || o.status === "unknown"),
  );
  const intentUnknown = intents.filter((i) => i.status === "unknown" && i.ruleId === "overseas");

  for (const unk of [...pendingOrUnknown.filter((o) => o.status === "unknown"), ...intentUnknown]) {
    const odno = "brokerOrderNo" in unk ? unk.brokerOrderNo : undefined;
    const hasEvidence =
      Boolean(odno) &&
      (input.openOrders.some((o) => sameOdno(o.orderNo, odno)) ||
        input.executions.some((e) => sameOdno(e.orderNo, odno)));
    if (!hasEvidence) {
      return {
        status: "UNKNOWN_BLOCKING",
        blocksNewBuy: true,
        message: "Unresolved UNKNOWN overseas order — no blind retry",
      };
    }
  }

  for (const open of input.openOrders) {
    const local = input.localOrders.find((o) => sameOdno(o.brokerOrderNo, open.orderNo));
    if (!local) {
      return {
        status: "REMOTE_ONLY",
        blocksNewBuy: true,
        message: `KIS open overseas ODNO ${open.orderNo} missing locally — recover or block`,
        matchedOdno: open.orderNo,
      };
    }
  }

  for (const order of pendingOrUnknown) {
    if (!order.brokerOrderNo) continue;
    const open = input.openOrders.find((o) => sameOdno(o.orderNo, order.brokerOrderNo));
    if (open) {
      return {
        status: "ACTIVE_MATCHED",
        blocksNewBuy: true,
        message: "Local submitted ODNO matched on KIS open orders",
        matchedOdno: order.brokerOrderNo,
      };
    }
    const exec = input.executions.find((e) => sameOdno(e.orderNo, order.brokerOrderNo));
    if (exec) {
      return {
        status: "EXECUTION_MATCHED",
        blocksNewBuy: false,
        message: "Local ODNO has KIS execution evidence",
        matchedOdno: order.brokerOrderNo,
      };
    }
  }

  const localOverseasWithOdno = pendingOrUnknown.filter((o) => o.brokerOrderNo);
  if (localOverseasWithOdno.length && input.openOrders.length === 0 && input.executions.length === 0) {
    return {
      status: "MISMATCH",
      blocksNewBuy: true,
      message: "Local overseas ODNO without KIS open/execution evidence",
    };
  }

  if (input.openOrders.length === 0 && pendingOrUnknown.length === 0 && intentUnknown.length === 0) {
    return { status: "HEALTHY", blocksNewBuy: false, message: "No active overseas orders" };
  }

  return { status: "HEALTHY", blocksNewBuy: false, message: "Overseas restart classification clear" };
}

export function overseasServerStartupAutoOrderSafe(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS !== "true";
}

export function applyExecutionToLocalQty(input: {
  orderQty: number;
  filledQty: number;
  remainingQty: number;
}): { positionDelta: number; stillActive: boolean } {
  const filled = Math.max(0, Math.min(input.orderQty, input.filledQty));
  const remaining =
    input.remainingQty >= 0 ? input.remainingQty : Math.max(0, input.orderQty - filled);
  return {
    positionDelta: filled,
    stillActive: remaining > 0 && filled < input.orderQty,
  };
}

export function overseasStateFromApp(state: AppState): {
  intents: OrderIntent[];
  orders: Order[];
} {
  return {
    intents: (state.intents ?? []).filter((row) => row.ruleId === "overseas"),
    orders: state.orders.filter(isOverseasLocalOrder),
  };
}
