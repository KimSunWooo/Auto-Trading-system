/**
 * Future AI admin surface — ADMIN only stub.
 * AI must never call broker order endpoints directly.
 */
import { AuthError, requireAdmin } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({
      ok: true,
      note: "AI proposals only. Path: proposal → Rule/Strategy → Signal → Risk → Intent → OrderManager → Broker",
      brokerOrderDirect: false,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST() {
  try {
    await requireAdmin();
    return Response.json(
      { error: "AI direct broker order is forbidden" },
      { status: 403 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
