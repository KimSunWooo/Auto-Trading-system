import { getDbPositions } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

function str(value: string | null): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

/** Current DB position snapshot. Does not replace runtime /api/state positions. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = await getDbPositions({
    account: str(url.searchParams.get("account")),
    market: str(url.searchParams.get("market")),
    symbol: str(url.searchParams.get("symbol")),
    rule: str(url.searchParams.get("rule")),
    limit: Number(url.searchParams.get("limit") ?? 50),
    cursor: str(url.searchParams.get("cursor")),
  });
  return Response.json({
    items: page.items,
    nextCursor: page.nextCursor,
    limit: page.limit,
  });
}
