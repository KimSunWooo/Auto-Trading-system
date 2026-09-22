import { cookies } from "next/headers";
import {
  clearSessionCookie,
  getUserFromSessionToken,
  SESSION_COOKIE,
  type AuthUser,
} from "@/src/auth/session";
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";

export async function getCurrentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  return getUserFromSessionToken(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError(401, "Authentication required");
  return user;
}

export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new AuthError(403, "ADMIN only");
  return user;
}

export async function requireOwnedBrokerAccount(brokerAccountId: string): Promise<{
  user: AuthUser;
  account: typeof schema.brokerAccounts.$inferSelect;
}> {
  const user = await requireUser();
  const db = getDb();
  if (!db) throw new AuthError(503, "Database unavailable");
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(eq(schema.brokerAccounts.id, brokerAccountId))
    .limit(1);
  const account = rows[0];
  if (!account || account.userId !== user.id) {
    throw new AuthError(403, "Broker account not owned by current user");
  }
  return { user, account };
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function applySessionCookie(
  response: Response,
  cookie: { name: string; value: string; httpOnly: boolean; sameSite: "lax"; path: string; secure: boolean; maxAge: number },
): Response {
  const parts = [
    `${cookie.name}=${encodeURIComponent(cookie.value)}`,
    `Path=${cookie.path}`,
    `Max-Age=${cookie.maxAge}`,
    "SameSite=Lax",
  ];
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.secure) parts.push("Secure");
  response.headers.append("Set-Cookie", parts.join("; "));
  return response;
}

export { clearSessionCookie, SESSION_COOKIE };
