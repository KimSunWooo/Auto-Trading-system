import { cookies } from "next/headers";
import { requireUser } from "@/src/auth/guards";
import { changeUserPassword, SESSION_COOKIE } from "@/src/auth/session";
import { runtimeJsonError } from "@/src/runtime/resolve-trading-runtime";

export const dynamic = "force-dynamic";

/** POST /api/auth/password — change password; revoke other sessions. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    };
    if (
      typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      typeof body.confirmPassword !== "string"
    ) {
      return Response.json(
        { error: "currentPassword, newPassword, confirmPassword required" },
        { status: 400 },
      );
    }
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    const result = await changeUserPassword({
      userId: user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
      currentSessionToken: token,
    });
    return Response.json({
      ok: true,
      otherSessionsRevoked: result.otherSessionsRevoked,
      message: "비밀번호가 변경되었습니다. 다른 세션은 종료되었습니다.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "password change failed";
    if (/incorrect|match|at least|required/i.test(message)) {
      return Response.json({ error: message }, { status: 400 });
    }
    return runtimeJsonError(err);
  }
}
