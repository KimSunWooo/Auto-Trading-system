/**
 * GET /api/accounts/current/verify
 * Authenticated read-only PAPER account binding + fresh broker snapshot.
 * Never returns secrets, full account numbers, or tokens.
 */
import { requireUser } from "@/src/auth/guards";
import { verifyPaperAccountForUser } from "@/src/auth/paper-account-verify";
import { resolveCurrentTradingRuntime, runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    let state = null;
    try {
      const runtime = await resolveCurrentTradingRuntime();
      state = runtime.store.readState();
    } catch {
      state = null;
    }
    const verification = await verifyPaperAccountForUser({
      userId: user.id,
      state,
    });
    return Response.json({
      verification,
      labels: {
        depositCash: "KIS 예수금 (dnca_tot_amt)",
        orderableCash: "KIS 주문가능금액 (ord_psbl_cash)",
        strategyCash: "전략 배정 잔액 (local allocation)",
      },
      ordersEnabled: false,
      autoTradingSystemConnected: false,
    });
  } catch (err) {
    return runtimeJsonError(err);
  }
}
