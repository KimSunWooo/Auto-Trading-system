/**
 * POST /api/instruments/preview
 * Body: { ticker?: string | null }
 * Syncs preview:<accountId> to exactly the selected domestic ticker (or clears).
 * Never subscribes autocomplete result lists.
 */
import { requireUser } from "@/src/auth/guards";
import { syncPreviewSubscription } from "@/src/instruments/dashboard-quotes";
import { resolveCurrentTradingRuntime, runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireUser();
    const body = (await request.json().catch(() => ({}))) as { ticker?: string | null };
    const rt = await resolveCurrentTradingRuntime();
    const result = await syncPreviewSubscription({
      brokerAccountId: rt.scope.brokerAccountId,
      kisClient: rt.scope.kisClient,
      ticker: body.ticker ?? null,
    });
    return Response.json({
      ...result,
      kisCalls: 0,
      policy: { priority: "preview", canEvictExecutionQuote: false },
    });
  } catch (err) {
    return runtimeJsonError(err);
  }
}
