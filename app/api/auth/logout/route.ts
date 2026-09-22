import { cookies } from "next/headers";
import { logoutSession, clearSessionCookie, SESSION_COOKIE } from "@/src/auth/session";
import { applySessionCookie } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

export async function POST() {
  const jar = await cookies();
  await logoutSession(jar.get(SESSION_COOKIE)?.value);
  const res = Response.json({ ok: true });
  return applySessionCookie(res, clearSessionCookie());
}
