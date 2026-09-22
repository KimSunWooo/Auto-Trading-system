import { createBrokerForRuntime } from "@/src/brokers/index";
import { CASH_RULE_ID, normalizeTicker } from "@/src/rules/params";
import type { Side } from "@/lib/types";
import { manualIntentId } from "@/src/runtime/intents";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import { isScopeStartupSyncDone } from "@/src/runtime/runtime-scope";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserTradingRuntime(async (rt) => {
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
    const rules = rt.rules.get();
    const safety = {
      startupSyncVerified: isScopeStartupSyncDone(rt.account.id),
      workerLockPath: rt.scope.lockPath,
    };

    let rejected: string | undefined;
    let unknown = false;
    const state = await rt.store.mutateStore(async (current) => {
      const box = { current };
      const intentId = manualIntentId({ ruleId, ticker: code, side, qty });
      const broker = createBrokerForRuntime(box, {
        kisClient: rt.scope.kisClient,
        persistState: rt.scope.persistState,
        ruleKey: ruleId,
        safety,
        quoteHub: rt.scope.quoteHub,
      })
        .forRule(ruleId)
        .withSource("manual")
        .withIntent({ intentId, signalId: intentId, reason: "manual" });
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
      return Response.json(
        { error: rejected, ...rt.store.toPublic(state, rules) },
        { status: unknown ? 409 : 400 },
      );
    }
    return Response.json(rt.store.toPublic(state, rules));
  });
}
