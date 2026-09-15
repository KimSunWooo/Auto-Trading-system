import { findStock } from "@/lib/universe";
import { mutateStore, toPublic } from "@/lib/store";
import { addDaysIso } from "@/lib/market-hours";
import { normalizeTicker } from "@/src/rules/params";
import type { AutoCondition, CompareOp, OrderPriceType, Side, WatchBasis } from "@/lib/types";

export const dynamic = "force-dynamic";

type Body = {
  code?: string;
  side?: Side;
  watchBasis?: WatchBasis;
  operator?: CompareOp;
  triggerPrice?: number;
  volumeEnabled?: boolean;
  volumeOp?: CompareOp;
  volume?: number;
  qty?: number;
  orderPriceType?: OrderPriceType;
  limitPrice?: number | null;
  expireDays?: number;
};

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  const code = normalizeTicker(body.code ?? "");
  if (!code) {
    return Response.json({ error: "종목코드 6자리를 입력하세요." }, { status: 400 });
  }
  const stock = findStock(code) ?? { code, name: code };
  const qty = Number(body.qty);
  const triggerPrice = Number(body.triggerPrice);
  if (!Number.isInteger(qty) || qty < 1) {
    return Response.json({ error: "수량은 1주 이상이어야 합니다." }, { status: 400 });
  }
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
    return Response.json({ error: "조건가격을 입력하세요." }, { status: 400 });
  }

  const expireDays = Math.min(90, Math.max(1, Number(body.expireDays ?? 30)));
  const now = new Date().toISOString();
  const cond: AutoCondition = {
    id: crypto.randomUUID(),
    code: stock.code,
    name: stock.name,
    side: body.side === "sell" ? "sell" : "buy",
    watchBasis: body.watchBasis ?? "last",
    operator: body.operator === "gte" ? "gte" : "lte",
    triggerPrice,
    volumeEnabled: Boolean(body.volumeEnabled),
    volumeOp: body.volumeOp === "lte" ? "lte" : "gte",
    volume: Math.max(0, Number(body.volume ?? 0)),
    qty,
    orderPriceType: body.orderPriceType === "limit" ? "limit" : "market",
    limitPrice:
      body.orderPriceType === "limit" && body.limitPrice
        ? Number(body.limitPrice)
        : null,
    expiresAt: addDaysIso(now, expireDays),
    watching: true,
    status: "watching",
    createdAt: now,
  };

  const state = await mutateStore((current) => ({
    ...current,
    conditions: [cond, ...current.conditions],
  }));

  return Response.json(toPublic(state));
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { id?: string; watching?: boolean };
  if (!body.id) {
    return Response.json({ error: "조건 ID가 필요합니다." }, { status: 400 });
  }

  const state = await mutateStore((current) => ({
    ...current,
    conditions: current.conditions.map((c) => {
      if (c.id !== body.id) return c;
      if (c.status === "filled" || c.status === "expired" || c.status === "rejected") {
        return c;
      }
      const watching = Boolean(body.watching);
      return {
        ...c,
        watching,
        status: watching ? ("watching" as const) : ("paused" as const),
        message: watching ? undefined : "감시를 중지했습니다.",
      };
    }),
  }));

  return Response.json(toPublic(state));
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return Response.json({ error: "조건 ID가 필요합니다." }, { status: 400 });
  }

  const state = await mutateStore((current) => ({
    ...current,
    conditions: current.conditions.filter((c) => {
      if (c.id !== id) return true;
      return c.watching && c.status === "watching" ? true : false;
    }).map((c) => c),
  }));

  const stillThere = state.conditions.some((c) => c.id === id);
  if (stillThere) {
    return Response.json(
      { error: "감시 중인 조건은 삭제할 수 없습니다. 먼저 감시를 중지하세요." },
      { status: 400 },
    );
  }

  return Response.json(toPublic(state));
}
