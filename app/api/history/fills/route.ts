import { getCurrentUser } from "@/src/auth/guards";
import {
  PaperAccountSelectionError,
  selectOwnedPaperAccount,
} from "@/src/auth/select-paper-account";
import { getOwnedFillHistory } from "@/src/db/repositories/fill-history";

export const dynamic = "force-dynamic";

/**
 * GET /api/history/fills — RDS executions (BUY+SELL) for the session's PAPER account.
 * Ignores client-supplied account ids.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다.", status: "unauthorized" }, { status: 401 });
  }

  let account;
  try {
    account = await selectOwnedPaperAccount(user.id);
  } catch (err) {
    if (err instanceof PaperAccountSelectionError) {
      return Response.json(
        {
          ok: false,
          status: "account_required",
          items: [],
          nextCursor: null,
          error: "마이페이지에서 PAPER 계좌 연결 상태를 확인해 주세요.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  const url = new URL(request.url);
  // Intentionally ignore ?account= — ownership comes from the session only.
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const days = Number(url.searchParams.get("days") ?? 90);
  const cursor = url.searchParams.get("cursor");

  const page = await getOwnedFillHistory({
    brokerAccountId: account.id,
    limit,
    days: Number.isFinite(days) ? days : 90,
    cursor,
  });

  if (!page.ok) {
    return Response.json(page, { status: page.status === "rds_unavailable" ? 503 : 409 });
  }
  return Response.json({
    ...page,
    accountIdPrefix: account.id.slice(0, 8),
    accountMasked: account.accountNumberMasked,
  });
}
