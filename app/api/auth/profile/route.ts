import { cookies } from "next/headers";
import { requireUser } from "@/src/auth/guards";
import { SESSION_COOKIE, updateUserDisplayName } from "@/src/auth/session";
import { runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const dynamic = "force-dynamic";

/** PATCH /api/auth/profile — update displayName only. */
export async function PATCH(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as { displayName?: string };
    if (typeof body.displayName !== "string") {
      return Response.json({ error: "displayName required" }, { status: 400 });
    }
    // Touch cookie jar so Next treats this as dynamic session path.
    await cookies();
    void SESSION_COOKIE;
    const updated = await updateUserDisplayName(user.id, body.displayName);
    return Response.json({
      user: {
        displayName: updated.displayName,
        role: updated.role,
        email: updated.email,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "profile update failed";
    if (/must be|required/i.test(message)) {
      return Response.json({ error: message }, { status: 400 });
    }
    return runtimeJsonError(err);
  }
}
