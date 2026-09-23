/**
 * GET /api/instruments/dashboard
 * Representative quotes only. Failure → stale/unavailable cards.
 * Never opens trading circuit. Never creates execution WS subscriptions.
 */
import { requireUser } from "@/src/auth/guards";
import { buildRepresentativeDashboard } from "@/src/instruments/dashboard-quotes";
import { resolveCurrentTradingRuntime, runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser();
    const country = new URL(request.url).searchParams.get("country") ?? undefined;
    let localQuotes: Record<string, { price: number; freshAt?: number; source?: string }> = {};
    let kisClient = null;
    try {
      const rt = await resolveCurrentTradingRuntime();
      const state = rt.store.readState();
      localQuotes = state.quotes ?? {};
      kisClient = rt.scope.kisClient ?? null;
    } catch {
      /* dashboard must not fail closed for trading */
    }
    const cards = buildRepresentativeDashboard({
      country,
      kisClient,
      localQuotes,
    });
    return Response.json({
      cards,
      policy: {
        blocksTradingOnFailure: false,
        canEvictExecutionQuote: false,
        searchCreatesWsSubscription: false,
      },
    });
  } catch (err) {
    return runtimeJsonError(err);
  }
}
