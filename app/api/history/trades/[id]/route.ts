import { getCurrentUser } from "@/src/auth/guards";
import {
  PaperAccountSelectionError,
  selectOwnedPaperAccount,
} from "@/src/auth/select-paper-account";
import { getTradeById } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let account;
  try {
    account = await selectOwnedPaperAccount(user.id);
  } catch (err) {
    if (err instanceof PaperAccountSelectionError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const { id } = await context.params;
  const trade = await getTradeById(id);
  if (!trade || trade.brokerAccountId !== account.id) {
    return Response.json({ error: "trade not found" }, { status: 404 });
  }
  return Response.json(trade);
}
