import { mutateStore, toPublic } from "@/lib/store";
import { createBroker } from "@/src/brokers/index";
import { CASH_RULE_ID, normalizeTicker } from "@/src/rules/params";
import type { Side } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    code?: string;
    side?: Side;
    qty?: number;
    ruleId?: string;
  };
  const code = normalizeTicker(body.code ?? "");
  if (!code) {
    return Response.json({ error: "종목코드 6자리를 입력하세요." }, { status: 400 });
  }
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1) {
    return Response.json({ error: "수량은 1주 이상이어야 합니다." }, { status: 400 });
  }
  const side = body.side === "sell" ? "sell" : "buy";
  const ruleId = body.ruleId || CASH_RULE_ID;

  let rejected: string | undefined;
  let unknown = false;
  const state = await mutateStore(async (current) => {
    const box = { current };
    const broker = createBroker(box).forRule(ruleId).withSource("manual");
    let price = current.quotes[code]?.price ?? 0;
    try {
      price = await broker.getCurrentPrice(code);
    } catch (err) {
      rejected = err instanceof Error ? err.message : "시세를 찾을 수 없습니다.";
      return current;
    }
    if (price <= 0) {
      rejected = "시세를 찾을 수 없습니다.";
      return current;
    }

    const fill =
      side === "sell"
        ? await broker.sellMarket(code, qty)
        : await broker.buyMarket(code, qty * price);

    if (fill.status === "unknown") {
      rejected = fill.reason ?? "주문 결과를 확인하지 못했습니다.";
      unknown = true;
    } else if (!fill.ok && fill.status !== "pending") {
      rejected = fill.reason ?? "주문에 실패했습니다.";
    }
    return box.current;
  });

  if (rejected) {
    return Response.json({ error: rejected, ...toPublic(state) }, { status: unknown ? 409 : 400 });
  }
  return Response.json(toPublic(state));
}
