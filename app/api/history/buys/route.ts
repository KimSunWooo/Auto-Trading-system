import { getBuyHistory } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

function str(value: string | null): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const page = await getBuyHistory({
    account: str(url.searchParams.get("account")),
    country: str(url.searchParams.get("country")),
    market: str(url.searchParams.get("market")),
    symbol: str(url.searchParams.get("symbol")),
    from: str(url.searchParams.get("from")),
    to: str(url.searchParams.get("to")),
    limit,
    cursor: str(url.searchParams.get("cursor")),
  });
  return Response.json({
    items: page.items,
    nextCursor: page.nextCursor,
    limit: page.limit,
  });
}
