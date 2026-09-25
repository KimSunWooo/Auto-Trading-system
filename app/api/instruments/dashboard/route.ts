/**
 * GET /api/instruments/dashboard
 * Representative quotes. Syncs dashboard:<accountId> consumer on existing hub.
 * Failure → stale/unavailable cards. Never opens trading circuit.
 * Never evicts execution subscriptions.
 */
import { requireUser } from "@/src/auth/guards";
import {
  buildRepresentativeDashboard,
  ensureDashboardSubscriptions,
} from "@/src/instruments/dashboard-quotes";
import { resolveCurrentTradingRuntime, runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireUser();
    const country = new URL(request.url).searchParams.get("country") ?? undefined;
    let localQuotes: Record<
      string,
      { price: number; bid?: number; ask?: number; freshAt?: number; source?: string }
    > = {};
    let kisClient = null;
    let brokerAccountId: string | null = null;
    let subscription = { consumerId: "", tickers: [] as string[], synced: false };
    try {
      const rt = await resolveCurrentTradingRuntime();
      const state = await rt.store.getState();
      localQuotes = state.quotes ?? {};
      kisClient = rt.scope.kisClient ?? null;
      brokerAccountId = rt.scope.brokerAccountId;
      subscription = await ensureDashboardSubscriptions({
        brokerAccountId,
        kisClient,
        country: country ?? "KR",
      });
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
      subscription,
      policy: {
        blocksTradingOnFailure: false,
        canEvictExecutionQuote: false,
        searchCreatesWsSubscription: false,
        priority: "dashboard",
      },
    });
  } catch (err) {
    return runtimeJsonError(err);
  }
}
