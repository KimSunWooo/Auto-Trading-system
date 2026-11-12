import { AuthError } from "@/src/auth/guards";
import { probeCurrentUserPaperConnection } from "@/src/auth/account-connection";

export const dynamic = "force-dynamic";

/** Read-only PAPER connection status for the logged-in user. Never places orders. */
export async function GET() {
  try {
    const status = await probeCurrentUserPaperConnection({ probeKis: true });
    return Response.json(status);
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "connection probe failed" },
      { status: 500 },
    );
  }
}

/** Explicit retry — same read-only probe. Session stays intact on failure. */
export async function POST() {
  try {
    const status = await probeCurrentUserPaperConnection({ probeKis: true });
    return Response.json({
      ...status,
      note: "Read-only retry complete. No orders submitted. REAL remains LOCKED.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "connection retry failed" },
      { status: 500 },
    );
  }
}
