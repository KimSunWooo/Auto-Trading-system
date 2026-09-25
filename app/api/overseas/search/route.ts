import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import type { UsExchange } from "@/src/markets/overseas/instruments";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { searchInstrumentsDetailed } from "@/src/instruments/search";
import { KisClient } from "@/src/brokers/kis-client";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

/**
 * Overseas search — Instrument Master DB is primary.
 * Autocomplete never calls KIS search API.
 * Selected quote is a separate endpoint/path (exchange + symbol exact).
 */
export async function GET(req: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const exchange = (url.searchParams.get("exchange")?.trim().toUpperCase() || undefined) as
      | UsExchange
      | undefined;
    const selectQuote = url.searchParams.get("quote") === "1";
    const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
    const selectedExchange = (url.searchParams.get("selectedExchange")?.trim().toUpperCase() ||
      undefined) as UsExchange | undefined;

    const client = rt.scope.kisClient;
    const kisReady = client instanceof KisClient && client.configured;

    // Selected instrument quote only (after DB master row pick).
    if (selectQuote && symbol && selectedExchange) {
      if (!kisReady) {
        return Response.json(
          {
            items: [],
            catalogSource: "none",
            catalogComplete: false,
            error: "PAPER_RUNTIME_KIS_NOT_CONFIGURED",
            kisCalls: 0,
            exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
            ordersEnabled: false,
          },
          { status: 409 },
        );
      }
      if (!["NASDAQ", "NYSE", "AMEX"].includes(selectedExchange)) {
        return Response.json(
          {
            error: "EXCHANGE_REQUIRED",
            message: "Master row exchange is required — silent NASDAQ fallback is forbidden",
            kisCalls: 0,
          },
          { status: 400 },
        );
      }
      try {
        const adapter = new OverseasTradingAdapter(client);
        const instrument = makeUsInstrument(selectedExchange, symbol);
        const quote = await adapter.getQuote(instrument);
        return Response.json({
          items: [{ instrument, quote }],
          catalogSource: "database-master",
          catalogComplete: true,
          source: "kis-quote",
          kisCalls: 1,
          exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
          ordersEnabled: overseasPaperOrdersLocked() === null,
        });
      } catch (err) {
        return Response.json(
          {
            error: err instanceof Error ? err.message : "해외주식 시세 조회 실패",
            kisCalls: 1,
            exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
            ordersEnabled: false,
          },
          { status: 502 },
        );
      }
    }

    // Autocomplete / catalog — DB master only, 0 KIS calls.
    const result = await searchInstrumentsDetailed({
      q: q || "A",
      country: "US",
      market: exchange,
      limit: 20,
    });

    if (!result.catalogComplete || result.error) {
      return Response.json({
        items: [],
        catalogSource: result.catalogSource,
        catalogComplete: false,
        error: result.error ?? "CATALOG_NOT_READY",
        message: "해외 종목 Master가 아직 적재되지 않았습니다. 시드 fallback 없음.",
        kisCalls: 0,
        exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
        ordersEnabled: false,
      });
    }

    const items = (q ? result.items : result.items).map((instrument) => ({
      instrument: {
        symbol: instrument.symbol,
        name: instrument.displayName,
        exchange: instrument.market as UsExchange,
        currency: instrument.currency,
        instrumentId: instrument.id,
        instrumentKey: instrument.instrumentKey,
      },
      quote: null,
    }));

    return Response.json({
      items,
      catalogSource: result.catalogSource,
      catalogComplete: result.catalogComplete,
      source: "db",
      message: "티커를 선택하면 KIS 해외 현재가를 조회합니다.",
      kisCalls: 0,
      exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
      ordersEnabled: overseasPaperOrdersLocked() === null,
    });
  });
}
