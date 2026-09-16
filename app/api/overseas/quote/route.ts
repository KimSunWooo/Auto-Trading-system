import { getSharedKisClient, KisClient } from "@/src/brokers/kis-client";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { parseOverseasInstrument } from "@/src/markets/overseas/instruments";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbol") ?? url.searchParams.get("q") ?? "NASDAQ:AAPL";
  const instrument = parseOverseasInstrument(raw) ?? parseOverseasInstrument(`NASDAQ:${raw}`);
  if (!instrument) {
    return Response.json({ error: "해외주식 심볼을 NASDAQ:AAPL 형식으로 입력하세요." }, { status: 400 });
  }
  try {
    const client = getSharedKisClient();
    if (!(client instanceof KisClient)) {
      return Response.json({ error: "해외 시세는 KisClient 가 필요합니다.", source: "unavailable" }, { status: 503 });
    }
    const quote = await new OverseasTradingAdapter(client).getQuote(instrument);
    return Response.json({ quote, exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "해외 시세 조회 실패", source: "kis" },
      { status: 502 },
    );
  }
}
