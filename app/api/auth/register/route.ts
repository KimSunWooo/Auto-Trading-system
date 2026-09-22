import { loginUser, registerUser } from "@/src/auth/session";
import { applySessionCookie } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      displayName?: string;
    };
    const user = await registerUser({
      email: body.email ?? "",
      password: body.password ?? "",
      displayName: body.displayName ?? "",
    });
    const logged = await loginUser({ email: body.email ?? "", password: body.password ?? "" });
    const res = Response.json({ user: logged.user ?? user });
    return applySessionCookie(res, logged.cookie);
  } catch (err) {
    const message = err instanceof Error ? err.message : "register failed";
    const status = /already/i.test(message) ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}
