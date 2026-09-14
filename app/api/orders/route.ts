import { applyFill } from "@/lib/engine";
import { findStock } from "@/lib/universe";
import { mutateStore, toPublic } from "@/lib/store";
import type { Side } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    code?: string;
    side?: Side;
    qty?: number;
  };
  const stock = findStock(body.code ?? "");
  if (!stock) {
    return Response.json({ error: "종목을 선택하세요." }, { status: 400 });
  }
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1) {
    return Response.json({ error: "수량은 1주 이상이어야 합니다." }, { status: 400 });
  }
  const side = body.side === "sell" ? "sell" : "buy";

  let rejected: string | undefined;
  const state = await mutateStore((current) => {
    const quote = current.quotes[stock.code];
    if (!quote) {
      rejected = "시세를 찾을 수 없습니다.";
      return current;
    }
    const applied = applyFill(current, {
      source: "manual",
      code: stock.code,
      name: stock.name,
      side,
      qty,
      price: quote.price,
    });
    if (applied.order.status === "rejected") {
      rejected = applied.order.reason;
      return applied.state;
    }
    return applied.state;
  });

  if (rejected) {
    return Response.json({ error: rejected, ...toPublic(state) }, { status: 400 });
  }
  return Response.json(toPublic(state));
}
