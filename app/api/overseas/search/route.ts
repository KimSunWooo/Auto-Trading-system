import { KisClient } from "@/src/brokers/kis-client";
import { OverseasTradingAdapter, seedInstruments } from "@/src/markets/overseas/adapter";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { parseOverseasInstrument, type UsExchange } from "@/src/markets/overseas/instruments";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const exchange = (url.searchParams.get("exchange")?.trim().toUpperCase() || undefined) as UsExchange | undefined;
    const client = rt.scope.kisClient;
    if (!(client instanceof KisClient) || !client.configured) {
      return Response.json({
        items: seedInstruments().map((instrument) => ({ instrument, quote: null })),
        source: "seed",
        message: "KIS가 설정되지 않아 시드 종목만 보여 줍니다.",
        exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
        ordersEnabled: false,
      });
    }
    try {
      const adapter = new OverseasTradingAdapter(client);
      if (!q) {
        return Response.json({
          items: seedInstruments().map((instrument) => ({ instrument, quote: null })),
          source: "kis-seed",
          message: "티커를 조회하면 KIS 공식 해외 현재가를 가져옵니다.",
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: overseasPaperOrdersLocked() === null,
        });
      }
      const parsed = parseOverseasInstrument(
        q,
        exchange === "NYSE" || exchange === "AMEX" || exchange === "NASDAQ" ? exchange : "NASDAQ",
      );
      const found = parsed
        ? ((await adapter.search(parsed.symbol, parsed.exchange)) ?? parsed)
        : await adapter.search(
            q,
            exchange === "NYSE" || exchange === "AMEX" || exchange === "NASDAQ" ? exchange : undefined,
          );
      if (!found) {
        return Response.json({
          items: [],
          source: "kis",
          message: "검색 결과가 없습니다.",
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: false,
        });
      }
      const quote = await adapter.getQuote(found);
      return Response.json({
        items: [{ instrument: found, quote }],
        source: "kis",
        exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
        ordersEnabled: overseasPaperOrdersLocked() === null,
      });
    } catch (err) {
      return Response.json(
        {
          error: err instanceof Error ? err.message : "해외주식 검색에 실패했습니다.",
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: false,
        },
        { status: 502 },
      );
    }
  });
}
