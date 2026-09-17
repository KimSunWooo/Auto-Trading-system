import { recordPending, patchOrder, bookReportedFill } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { KisApi, KisDayOrder } from "@/src/brokers/kis-client";
import { padOdno, sameOdno } from "@/src/brokers/kis-client";
import { findStock } from "@/lib/universe";
import { CASH_RULE_ID } from "@/src/rules/params";
import { openCircuit } from "@/src/risk/circuit";
import { blockSafety, safetyOf } from "@/src/runtime/safety";
import { upsertIntent, patchIntent } from "@/src/runtime/intents";
import { isRecoverableInquiryHalt } from "@/src/runtime/controlled-run";
import {
  classifyLocalActiveOrder,
  findActiveUnknownOrder,
  inferOrderProvenance,
  isActiveUnknownBlocker,
  mergeRemoteOrders,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";
import type { AppState, Order } from "@/lib/types";

export type InquiryResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function inquireOrFail<T>(fn: () => Promise<T>): Promise<InquiryResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "증권사 조회에 실패했습니다." };
  }
}

function alreadyTracked(state: AppState, orderNo: string): Order | undefined {
  return state.orders.find((row) => sameOdno(row.brokerOrderNo, orderNo));
}

function attachIdentity(box: StateBox, remote: KisDayOrder): boolean {
  const ghosts = box.current.orders.filter(
    (order) =>
      !order.parentOrderId &&
      !order.brokerOrderNo &&
      (order.status === "pending" || order.status === "unknown") &&
      order.activeClass !== "ORPHANED_LOCAL",
  );
  const unmatched = remote;
  const ghost = ghosts.length === 1 ? ghosts[0] : undefined;
  if (!ghost) return false;
  if (ghost.code !== unmatched.ticker || ghost.side !== unmatched.side) return false;
  if ((ghost.orderedQty ?? ghost.qty) !== unmatched.qty) return false;
  const patched = patchOrder(box.current, ghost.id, {
    brokerOrderNo: unmatched.orderNo,
    status: ghost.status === "unknown" ? "pending" : ghost.status,
    activeClass: unmatched.unfilledQty > 0 ? "ACTIVE_MATCHED" : "HISTORICAL_MATCHED",
    provenance: "RECOVERED_ORDER",
    reason: "RECOVERED_ORDER · 로컬 미확인 주문에 증권사 ODNO를 연결했습니다.",
  });
  if (!patched.order) return false;
  box.current = patchIntent(patched.state, ghost.intentId, {
    status: "submitted",
    orderId: ghost.id,
    brokerOrderNo: unmatched.orderNo,
  });
  return true;
}

function adoptRemote(box: StateBox, row: KisDayOrder): void {
  if (!row.orderNo) return;
  if (alreadyTracked(box.current, row.orderNo)) return;
  const stock = findStock(row.ticker);
  const fallback =
    [...box.current.allocations].sort((a, b) => b.budget - a.budget)[0]?.ruleId ?? CASH_RULE_ID;
  const intentId = `recovered:${row.orderNo}`;
  const committed = upsertIntent(box.current, {
    intentId,
    signalId: intentId,
    ruleId: fallback,
    ticker: row.ticker,
    side: row.side,
    qty: row.qty,
    price: row.avgPrice || 0,
    reason: "RECOVERED_ORDER",
  });
  const started = recordPending(committed.state, {
    intentId,
    source: "rule",
    ruleId: fallback,
    code: row.ticker,
    name: stock?.name ?? row.ticker,
    side: row.side,
    qty: row.qty,
    price: row.avgPrice || 1,
    ordDvsn: "limit",
  });
  const withNo = patchOrder(started.state, started.order.id, {
    status: row.unfilledQty > 0 ? "pending" : "pending",
    brokerOrderNo: row.orderNo,
    reason: "RECOVERED_ORDER · 증권사 주문을 로컬에 편입했습니다.",
    orderedQty: row.qty,
    filledQty: 0,
    activeClass: row.unfilledQty > 0 ? "ACTIVE_MATCHED" : "HISTORICAL_MATCHED",
    provenance: "RECOVERED_ORDER",
  });
  box.current = patchIntent(withNo.state, intentId, {
    status: "submitted",
    orderId: started.order.id,
    brokerOrderNo: row.orderNo,
  });
  if (row.filledQty > 0) {
    const booked = bookReportedFill(box.current, started.order.id, {
      filledQty: row.filledQty,
      avgPrice: row.avgPrice,
      brokerOrderNo: row.orderNo,
    });
    box.current = booked.state;
  }
}

/**
 * Reconcile local active tickets with KIS open + daily inquiries.
 * Historical / orphaned local-only tickets are classified and do not open the circuit.
 */
export async function recoverExternalOrders(box: StateBox, client: KisApi): Promise<InquiryResult<number>> {
  const open = await inquireOrFail(() => client.inquireOpenOrders());
  if (!open.ok) return open;
  const daily = await inquireOrFail(() => client.inquireDailyCcld());
  if (!daily.ok) return daily;

  const remote = mergeRemoteOrders(open.value, daily.value);
  const unmatched = remote.filter((row) => !alreadyTracked(box.current, row.orderNo));
  if (unmatched.length === 1) {
    attachIdentity(box, unmatched[0]!);
  }

  let adopted = 0;
  for (const row of remote) {
    if (!row.orderNo) continue;
    if (alreadyTracked(box.current, row.orderNo)) continue;
    adoptRemote(box, row);
    adopted += 1;
  }

  const paperAware = usesPaperStartupSync();
  const stillLocal = box.current.orders.filter(
    (order) =>
      !order.parentOrderId &&
      (order.status === "pending" || order.status === "unknown") &&
      order.activeClass !== "ORPHANED_LOCAL" &&
      order.activeClass !== "HISTORICAL_MATCHED",
  );

  for (const local of stillLocal) {
    const match = local.brokerOrderNo
      ? remote.find((row) => sameOdno(row.orderNo, local.brokerOrderNo))
      : undefined;
    if (match) continue;

    if (paperAware) {
      const classified = classifyLocalActiveOrder(local, remote);
      const provenance = inferOrderProvenance(local);
      if (classified.classification === "ORPHANED_LOCAL") {
        const patched = patchOrder(box.current, local.id, {
          activeClass: "ORPHANED_LOCAL",
          provenance,
          reason: classified.reason,
        });
        if (patched.order) box.current = patched.state;
        continue;
      }
      if (classified.classification === "UNKNOWN_ACTIVE") {
        const patched = patchOrder(box.current, local.id, {
          status: "unknown",
          activeClass: "UNKNOWN_ACTIVE",
          provenance,
          reason: classified.reason,
        });
        if (patched.order) {
          box.current = openCircuit(patched.state, classified.reason, patched.order);
        }
        continue;
      }
    }

    // Non-PAPER / legacy path: only escalate today's active unknowns.
    const patched = patchOrder(box.current, local.id, {
      status: "unknown",
      activeClass: "UNKNOWN_ACTIVE",
      reason:
        "현재 KIS PAPER 계좌에서 이 주문의 활성 상태를 확인할 수 없습니다. 자동 재주문하지 않습니다.",
    });
    if (patched.order) {
      box.current = openCircuit(
        patched.state,
        patched.order.reason ?? "로컬 주문과 증권사 주문이 맞지 않습니다.",
        patched.order,
      );
    }
  }

  const ghosts = box.current.orders.filter(
    (order) =>
      !order.parentOrderId &&
      !order.brokerOrderNo &&
      (order.status === "pending" || order.status === "unknown") &&
      order.activeClass !== "ORPHANED_LOCAL",
  );
  for (const ghost of ghosts) {
    if (paperAware) {
      const classified = classifyLocalActiveOrder(ghost, remote);
      if (classified.classification === "ORPHANED_LOCAL") {
        const patched = patchOrder(box.current, ghost.id, {
          activeClass: "ORPHANED_LOCAL",
          provenance: inferOrderProvenance(ghost),
          reason: classified.reason,
        });
        if (patched.order) box.current = patched.state;
        continue;
      }
    }
    const patched = patchOrder(box.current, ghost.id, {
      status: "unknown",
      activeClass: "UNKNOWN_ACTIVE",
      reason: "증권사 주문번호가 없어 미확인으로 유지합니다. 자동 재주문하지 않습니다.",
    });
    if (patched.order) {
      box.current = openCircuit(
        patched.state,
        patched.order.reason ?? "ODNO 없는 로컬 주문",
        patched.order,
      );
    }
  }

  return { ok: true, value: adopted };
}

export function markInquiryFailure(state: AppState, kind: "recon" | "data" | "broker", reason: string): AppState {
  const blocked = blockSafety(
    state,
    kind === "data"
      ? "market_data_unavailable"
      : kind === "broker"
        ? "broker_unavailable"
        : "reconciliation_unavailable",
    reason,
    {
      quoteOk: kind !== "data",
      brokerConnected: kind !== "broker",
      reconciliation: kind === "recon" ? "unavailable" : safetyOf(state).reconciliation,
    },
  );
  return openCircuit(
    blocked,
    reason,
    undefined,
    kind === "data" ? "data" : kind === "broker" ? "hard" : "recon",
  );
}

export function resetRecoverableHalt(state: AppState): AppState {
  if (!isRecoverableInquiryHalt(state)) return state;
  if (findActiveUnknownOrder(state)) return state;
  return {
    ...state,
    circuit: {
      halted: false,
      kind: undefined,
      unknownCount: state.circuit?.unknownCount ?? 0,
    },
  };
}

export { isActiveUnknownBlocker };
