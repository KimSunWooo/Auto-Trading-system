/**
 * GET /api/accounts/current/verify
 * Authenticated read-only PAPER account binding + fresh broker snapshot.
 * Never returns secrets, full account numbers, or tokens.
 *
 * Runtime resolve failure is NOT swallowed as a silent READY path —
 * it is passed through as RUNTIME_RESOLUTION_FAILED (readyForTrading=false).
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
    let runtimeResolutionFailed = false;
    try {
      const tradingRuntime = await resolveCurrentTradingRuntime();
      state = await tradingRuntime.store.getState();
    } catch {
      runtimeResolutionFailed = true;
      state = null;
    }
    const verification = await verifyPaperAccountForUser({
      userId: user.id,
      state,
      runtimeResolutionFailed,
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
      runtimeReady: !runtimeResolutionFailed && verification.runtimeClientVerified,
      message: runtimeResolutionFailed
        ? "계좌는 존재하지만 Runtime 준비 실패 — 신규 주문 차단"
        : undefined,
    });
  } catch (err) {
    return runtimeJsonError(err);
  }
}
