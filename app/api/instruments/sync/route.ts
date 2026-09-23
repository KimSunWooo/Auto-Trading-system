import { AuthError, requireAdmin } from "@/src/auth/guards";
import { fixtureSyncSources, syncInstrumentSources } from "@/src/instruments/sync";
import path from "node:path";

export const dynamic = "force-dynamic";

/** POST /api/instruments/sync — ADMIN only. Loads fixture masters by default (no KIS). */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      fixturesDir?: string;
      sources?: string[];
    };
    const fixturesDir =
      body.fixturesDir?.trim() ||
      path.join(process.cwd(), "src/instruments/fixtures");
    let sources = fixtureSyncSources(fixturesDir);
    if (Array.isArray(body.sources) && body.sources.length > 0) {
      const allow = new Set(body.sources.map((s) => String(s).toUpperCase()));
      sources = sources.filter((s) => allow.has(s.id));
    }
    const results = await syncInstrumentSources(sources);
    const failed = results.filter((r) => r.status === "FAILED");
    return Response.json(
      {
        results,
        ok: failed.length === 0,
        failedCount: failed.length,
      },
      { status: failed.length === results.length && results.length > 0 ? 502 : 200 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "instrument sync failed" },
      { status: 500 },
    );
  }
}
