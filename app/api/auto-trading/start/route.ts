import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import {
  buildLostStartRequestRecovery,
  enqueueAutoTradingStart,
  getAutoTradingStartJob,
  getActiveAutoTradingStartJobForAccount,
  toAutoTradingStartPublic,
} from "@/src/runtime/auto-trading-start-job";

export const dynamic = "force-dynamic";

/**
 * POST — enqueue PAPER auto-trading start (async).
 * Returns immediately with requestId; poll GET /api/auto-trading/start?requestId=…
 *
 * Body: { disclaimerAccepted?: boolean }
 * Never places orders. REAL accounts are rejected.
 */
export async function POST(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json().catch(() => ({}))) as {
      disclaimerAccepted?: boolean;
      requestId?: string;
    };

    // Idempotent poll via POST body.requestId (optional convenience).
    if (body.requestId) {
      const existing = getAutoTradingStartJob(body.requestId);
      if (!existing || existing.userId !== rt.user.id) {
        const recovery = await buildLostStartRequestRecovery(body.requestId, rt.account.id);
        return Response.json(recovery, { status: 404 });
      }
      return Response.json(toAutoTradingStartPublic(existing));
    }

    const { job, reused } = enqueueAutoTradingStart({
      rt,
      disclaimerAccepted: body.disclaimerAccepted !== false,
    });

    return Response.json(
      {
        ...toAutoTradingStartPublic(job),
        reused,
        pollUrl: `/api/auto-trading/start?requestId=${encodeURIComponent(job.requestId)}`,
      },
      { status: reused ? 200 : 202 },
    );
  });
}

/**
 * GET — poll start job by requestId, or active job for current account.
 * Missing requestId after restart → 404 START_REQUEST_LOST with current RDS ON/OFF
 * (never auto-retransmits start).
 */
export async function GET(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");

    if (requestId) {
      const job = getAutoTradingStartJob(requestId);
      if (!job || job.userId !== rt.user.id) {
        const recovery = await buildLostStartRequestRecovery(requestId, rt.account.id);
        return Response.json(recovery, { status: 404 });
      }
      return Response.json(toAutoTradingStartPublic(job));
    }

    const active = getActiveAutoTradingStartJobForAccount(rt.account.id);
    if (active && active.userId === rt.user.id) {
      return Response.json(toAutoTradingStartPublic(active));
    }

    return Response.json({
      requestId: null,
      status: "idle",
      uiStatus: "대기",
      message: "진행 중인 시작 요청이 없습니다.",
      autoTradingOnInRds: null,
    });
  });
}
