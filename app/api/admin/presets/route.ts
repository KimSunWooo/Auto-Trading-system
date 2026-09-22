/**
 * Strategy presets — ADMIN only (server-side).
 * USER always receives 403. Does not place orders.
 */
import { AuthError, requireAdmin } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

const PRESETS = [
  {
    id: "stable",
    name: "안정형",
    description: "낮은 회전·보수적 비중. ADMIN review only.",
  },
  {
    id: "balanced",
    name: "일반형",
    description: "균형 비중. ADMIN review only.",
  },
  {
    id: "aggressive",
    name: "공격형",
    description: "높은 회전. ADMIN review only.",
  },
] as const;

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ presets: PRESETS });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
