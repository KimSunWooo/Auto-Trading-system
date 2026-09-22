import { KisClient } from "@/src/brokers/kis-client";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { parseOverseasInstrument } from "@/src/markets/overseas/instruments";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(req.url);
    const raw = url.searchParams.get("symbol") ?? "NASDAQ:AAPL";
    const instrument = parseOverseasInstrument(raw) ?? parseOverseasInstrument("NASDAQ:AAPL");
    try {
      const client = rt.scope.kisClient;
      if (!(client instanceof KisClient)) {
        return Response.json(
          {
            account: null,
            openOrders: [],
            executions: [],
            ordersEnabled: false,
            exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
            message: "해외 잔고는 KisClient 가 필요합니다.",
          },
          { status: 503 },
        );
      }
      const adapter = new OverseasTradingAdapter(client);
      const account = await adapter.assembleAccount(instrument?.symbol ?? "AAPL", instrument?.exchange ?? "NASDAQ");
      const openOrders = await adapter.getOpenOrders(instrument?.exchange ?? "NASDAQ");
      const executions = await adapter.getExecutions();
      return Response.json({
        account,
        openOrders,
        executions,
        ordersEnabled: overseasPaperOrdersLocked() === null,
        exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
      });
    } catch (err) {
      return Response.json(
        {
          error: err instanceof Error ? err.message : "해외 잔고 조회 실패",
          account: null,
          ordersEnabled: false,
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
        },
        { status: 502 },
      );
    }
  });
}
