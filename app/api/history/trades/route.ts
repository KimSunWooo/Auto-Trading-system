import { getTradeHistory } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

function str(value: string | null): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = await getTradeHistory({
    account: str(url.searchParams.get("account")),
    country: str(url.searchParams.get("country")),
    market: str(url.searchParams.get("market")),
    symbol: str(url.searchParams.get("symbol")),
    rule: str(url.searchParams.get("rule")),
    status: str(url.searchParams.get("status")),
    from: str(url.searchParams.get("from")),
    to: str(url.searchParams.get("to")),
    limit: Number(url.searchParams.get("limit") ?? 50),
    cursor: str(url.searchParams.get("cursor")),
  });
  return Response.json({
    items: page.items,
    nextCursor: page.nextCursor,
    limit: page.limit,
  });
}
