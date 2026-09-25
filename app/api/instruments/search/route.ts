import { AuthError, requireUser } from "@/src/auth/guards";
import { searchInstrumentsDetailed } from "@/src/instruments/search";
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";

export const dynamic = "force-dynamic";

/** GET /api/instruments/search?q=&country=&market=&type=&limit= — auth required, no KIS. */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const country = url.searchParams.get("country")?.trim() || undefined;
    const market = url.searchParams.get("market")?.trim() || undefined;
    const type = url.searchParams.get("type")?.trim() || undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 20;

    const result = await searchInstrumentsDetailed({ q, country, market, type, limit });
    return Response.json({
      items: result.items,
      catalogSource: result.catalogSource,
      catalogComplete: result.catalogComplete,
      error: result.error,
      source: result.catalogSource,
      representatives: q ? undefined : configDashboardRepresentatives(country),
      kisCalls: 0,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "instrument search failed" },
      { status: 500 },
    );
  }
}
