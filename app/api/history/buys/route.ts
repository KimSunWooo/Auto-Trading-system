import { getCurrentUser } from "@/src/auth/guards";
import {
  PaperAccountSelectionError,
  selectOwnedPaperAccount,
} from "@/src/auth/select-paper-account";
import { getBuyHistory } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

function str(value: string | null): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

/** GET buys — scoped to session PAPER account (client account id ignored). */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let account;
  try {
    account = await selectOwnedPaperAccount(user.id);
  } catch (err) {
    if (err instanceof PaperAccountSelectionError) {
      return Response.json({ items: [], nextCursor: null, error: err.message }, { status: 409 });
    }
    throw err;
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const page = await getBuyHistory({
    account: account.id,
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
    mode: "mode" in page ? page.mode : undefined,
  });
}
