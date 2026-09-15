import { bookReportedFill, patchOrder } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { KisApi, KisDayOrder } from "@/src/brokers/kis-client";
import { sameOdno } from "@/src/brokers/kis-client";
import { openCircuit } from "@/src/risk/circuit";
import { isIndeterminateError } from "@/src/risk/errors";
import { HARD_LIMITS } from "@/src/risk/limits";
import { nowMs } from "@/src/clock";
import type { Order } from "@/lib/types";

function openParents(box: StateBox): Order[] {
  return box.current.orders.filter(
    (order) =>
      !order.parentOrderId &&
      Boolean(order.brokerOrderNo) &&
      (order.status === "unknown" || order.status === "pending"),
  );
}

function findCcld(remote: KisDayOrder[], order: Order): KisDayOrder | undefined {
  const byNo = remote.find((row) => sameOdno(row.orderNo, order.brokerOrderNo));
  if (byNo) return byNo;
  return remote.find(
    (row) =>
      row.ticker === order.code &&
      row.side === order.side &&
      row.qty === (order.orderedQty ?? order.qty) &&
      row.filledQty > 0,
  );
}

function remainingOf(order: Order, match: KisDayOrder | undefined): number {
  const ordered = order.orderedQty ?? order.qty;
  const booked = order.filledQty ?? 0;
  if (!match) return Math.max(0, ordered - booked);
  if (match.unfilledQty > 0) return match.unfilledQty;
  return Math.max(0, (match.qty || ordered) - match.filledQty);
}

async function bookRemoteFill(
  box: StateBox,
  order: Order,
  match: KisDayOrder,
): Promise<Order | undefined> {
  if (match.filledQty <= (order.filledQty ?? 0)) {
    return box.current.orders.find((row) => row.id === order.id);
  }
  const booked = bookReportedFill(box.current, order.id, {
    filledQty: match.filledQty,
    avgPrice: match.avgPrice || order.price,
    brokerOrderNo: match.orderNo || order.brokerOrderNo,
  });
  if (booked.parent.status === "unknown") {
    box.current = openCircuit(
      booked.state,
      booked.parent.reason ?? "증권사 체결을 로컬 장부에 반영하지 못했습니다.",
      booked.parent,
    );
    return booked.parent;
  }
  box.current = booked.state;
  return booked.parent;
}

function closeRemainder(box: StateBox, order: Order, filled: number, ordered: number) {
  if (filled >= ordered && filled > 0) {
    const patched = patchOrder(box.current, order.id, {
      status: "filled",
      filledQty: filled,
      reason: "전량 체결",
    });
    if (patched.order) box.current = patched.state;
    return;
  }
  if (filled > 0) {
    const patched = patchOrder(box.current, order.id, {
      status: "filled",
      filledQty: filled,
      reason: `부분체결 ${filled}주, 잔량 취소`,
    });
    if (patched.order) box.current = patched.state;
    return;
  }
  const patched = patchOrder(box.current, order.id, {
    status: "cancelled",
    filledQty: 0,
    reason: "미체결 잔량 취소",
  });
  if (patched.order) box.current = patched.state;
}

/**
 * Mirror KIS daily ccld onto the local book, then cancel leftover qty
 * after HARD_LIMITS.cancelUnfilledAfterMs.
 */
export async function settleOpenOrders(
  box: StateBox,
  client: KisApi,
  now = nowMs(),
  opts: { cancelImmediately?: boolean; bookOnly?: boolean } = {},
) {
  const open = openParents(box);
  if (open.length === 0 || !client.configured) return;

  let remote: KisDayOrder[] = [];
  try {
    remote = await client.inquireDailyCcld();
  } catch {
    return;
  }

  for (const snapshot of open) {
    const live = box.current.orders.find((row) => row.id === snapshot.id);
    if (!live || live.parentOrderId) continue;
    if (live.status !== "pending" && live.status !== "unknown") continue;

    const match = findCcld(remote, live);
    if (match) {
      const afterFill = await bookRemoteFill(box, live, match);
      if (!afterFill || afterFill.status === "unknown") continue;
    }

    const current = box.current.orders.find((row) => row.id === snapshot.id);
    if (!current || (current.status !== "pending" && current.status !== "unknown")) continue;

    const ordered = current.orderedQty ?? current.qty;
    const filled = current.filledQty ?? 0;
    const remaining = remainingOf(current, match);
    if (remaining < 1) {
      closeRemainder(box, current, filled, ordered);
      continue;
    }

    if (opts.bookOnly) continue;

    const age = now - new Date(current.createdAt).getTime();
    if (!opts.cancelImmediately && age < HARD_LIMITS.cancelUnfilledAfterMs) continue;
    if (!current.brokerOrderNo) continue;

    try {
      await client.cancelOrder({
        orderNo: current.brokerOrderNo,
        krxOrgNo: current.krxOrgNo ?? "",
        ordDvsn: current.ordDvsn ?? "market",
      });
    } catch (err) {
      if (isIndeterminateError(err)) {
        const patched = patchOrder(box.current, current.id, {
          status: "unknown",
          reason: err instanceof Error ? err.message : "잔량 취소 결과를 확인하지 못했습니다.",
        });
        if (patched.order) {
          box.current = openCircuit(
            patched.state,
            patched.order.reason ?? "잔량 취소 미확인",
            patched.order,
          );
        }
        continue;
      }
    }

    try {
      remote = await client.inquireDailyCcld();
    } catch {
      // cancel went out; close locally using last known fill
    }
    const afterCancel = box.current.orders.find((row) => row.id === snapshot.id);
    if (!afterCancel) continue;
    const latest = findCcld(remote, afterCancel);
    if (latest) {
      const booked = await bookRemoteFill(box, afterCancel, latest);
      if (!booked || booked.status === "unknown") continue;
    }
    const final = box.current.orders.find((row) => row.id === snapshot.id);
    if (!final || (final.status !== "pending" && final.status !== "unknown")) continue;
    closeRemainder(box, final, final.filledQty ?? 0, final.orderedQty ?? final.qty);
  }
}

/** @deprecated Use settleOpenOrders. Kept for callers that still import the old name. */
export async function reconcileUnknownOrders(box: StateBox, client: KisApi) {
  return settleOpenOrders(box, client);
}

export function expireStaleInFlight(box: StateBox, maxAgeMs = 15_000) {
  const now = nowMs();
  for (const order of box.current.orders) {
    if (order.status !== "pending" || order.brokerOrderNo) continue;
    if (now - new Date(order.createdAt).getTime() < maxAgeMs) continue;
    const patched = patchOrder(box.current, order.id, {
      status: "unknown",
      reason: "응답 대기 시간이 지나 미확인으로 전환했습니다.",
    });
    if (patched.order) {
      box.current = openCircuit(patched.state, patched.order.reason ?? "미확인 주문", patched.order);
    }
  }
}
