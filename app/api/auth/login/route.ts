import { loginUser } from "@/src/auth/session";
import { applySessionCookie } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { email?: string; password?: string };
    const logged = await loginUser({
      email: body.email ?? "",
      password: body.password ?? "",
    });
    const res = Response.json({ user: logged.user });
    return applySessionCookie(res, logged.cookie);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "login failed" },
      { status: 401 },
    );
  }
}
