import { KisClient } from "@/src/brokers/kis-client";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import { parseOverseasInstrument, type UsExchange } from "@/src/markets/overseas/instruments";
import { searchInstruments } from "@/src/instruments/search";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const exchange = (url.searchParams.get("exchange")?.trim().toUpperCase() || undefined) as
      | UsExchange
      | undefined;
    const client = rt.scope.kisClient;
    if (!(client instanceof KisClient) || !client.configured) {
      return Response.json(
        {
          items: [],
          source: "none",
          error: "PAPER_RUNTIME_KIS_NOT_CONFIGURED",
          message: "KIS PAPER runtime이 준비되지 않았습니다. 시드 종목 fallback은 없습니다.",
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: false,
        },
        { status: 409 },
      );
    }

    // Empty query: Instrument Master catalog only (no seed list).
    if (!q) {
      const catalog = await searchInstruments({ q: "A", country: "US", market: exchange, limit: 20 });
      // Prefer empty catalog signal when master not loaded — use short probe via known symbol prefix.
      const probe = await searchInstruments({ q: "AAPL", country: "US", limit: 5 });
      if (!probe.length && !catalog.length) {
        return Response.json({
          items: [],
          source: "db",
          error: "CATALOG_NOT_READY",
          message: "해외 종목 Master가 아직 적재되지 않았습니다.",
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: false,
        });
      }
      return Response.json({
        items: (probe.length ? probe : catalog).map((instrument) => ({
          instrument: {
            symbol: instrument.symbol,
            name: instrument.displayName,
            exchange: instrument.market,
            currency: instrument.currency,
          },
          quote: null,
        })),
        source: "db",
        message: "티커를 선택하면 KIS 해외 현재가를 조회합니다.",
        exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
        ordersEnabled: overseasPaperOrdersLocked() === null,
      });
    }

    try {
      const adapter = new OverseasTradingAdapter(client);
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
