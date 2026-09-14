import { confirmPendingFill, patchOrder } from "@/src/accounts/fills";
import type { StateBox } from "@/src/accounts/StateBox";
import type { KisApi } from "@/src/brokers/kis-client";
import { openCircuit } from "@/src/risk/circuit";

export async function reconcileUnknownOrders(box: StateBox, client: KisApi) {
  const open = box.current.orders.filter(
    (order) => order.status === "unknown" || (order.status === "pending" && order.brokerOrderNo),
  );
  if (open.length === 0 || !client.configured) return;

  let remote: Awaited<ReturnType<KisApi["inquireDailyCcld"]>> = [];
  try {
    remote = await client.inquireDailyCcld();
  } catch {
    return;
  }
  if (remote.length === 0) return;

  for (const order of open) {
    const match = remote.find((row) => {
      if (order.brokerOrderNo && row.orderNo === order.brokerOrderNo) return true;
      return (
        row.ticker === order.code &&
        row.side === order.side &&
        row.qty === order.qty &&
        row.filledQty > 0
      );
    });
    if (!match || match.filledQty < 1) continue;
    if (order.status === "unknown" || order.status === "pending") {
      const filled = confirmPendingFill(box.current, order.id, {
        brokerOrderNo: match.orderNo,
        qty: match.filledQty,
        price: match.avgPrice || order.price,
      });
      box.current = {
        ...filled.state,
        orders: filled.state.orders.map((row) =>
          row.id === order.id
            ? { ...row, brokerOrderNo: match.orderNo, intentId: order.intentId }
            : row,
        ),
      };
    }
  }
}

export function expireStaleInFlight(box: StateBox, maxAgeMs = 15_000) {
  const now = Date.now();
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
