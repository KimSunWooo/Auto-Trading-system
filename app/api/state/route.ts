import { toDashboardSummary } from "@/src/runtime/dashboard-summary";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/state
 * - default / ?view=full → full PublicState (existing contract)
 * - ?view=dashboard → slim summary for auto-refresh (no orders/fills book)
 * - ?trace=1 → Server-Timing style JSON timings (read-only diagnostics)
 */
export async function GET(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const trace = url.searchParams.get("trace") === "1";
    const started = Date.now();
    const marks: Record<string, number> = {};

    const mark = (name: string) => {
      marks[name] = Date.now() - started;
    };

    const state = await rt.store.getPublicState(rt.rules.get());
    mark("getPublicStateMs");

    const body =
      view === "dashboard" ? toDashboardSummary(state) : state;
    mark("projectMs");

    if (trace) {
      const json = JSON.stringify(body);
      mark("serializeMs");
      return Response.json({
        ...body,
        _trace: {
          view: view === "dashboard" ? "dashboard" : "full",
          bytes: Buffer.byteLength(json),
          totalMs: Date.now() - started,
          ...marks,
          accountIdPrefix: rt.account.id.slice(0, 8),
        },
      });
    }

    return Response.json(body);
  });
}
