/**
 * Strategy presets — ADMIN only (server-side).
 * USER always receives 403. Does not place orders.
 * Full preset drafts are returned only to ADMIN so USER bundles stay free of preset data.
 */
import { AuthError, requireAdmin } from "@/src/auth/guards";
import { ADMIN_PRESETS } from "@/src/rules/admin-presets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({
      presets: ADMIN_PRESETS,
      authority: "users.role===ADMIN",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
