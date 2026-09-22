import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { hashPassword, verifyPassword } from "@/src/auth/password";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: "USER" | "ADMIN";
  status: string;
};

export type SessionCookie = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
};

export const SESSION_COOKIE = "mirae_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 14;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function nowMysql(): string {
  return new Date().toISOString().slice(0, 23).replace("T", " ");
}

function expiresMysql(secFromNow: number): string {
  return new Date(Date.now() + secFromNow * 1000)
    .toISOString()
    .slice(0, 23)
    .replace("T", " ");
}

let schemaReady: Promise<void> | null = null;
async function readyDb() {
  if (!schemaReady) schemaReady = ensureAuthSchema().catch((err) => {
    schemaReady = null;
    throw err;
  });
  await schemaReady;
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");
  return db;
}

export async function registerUser(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<AuthUser> {
  const db = await readyDb();
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@") || input.password.length < 8) {
    throw new Error("Invalid email or password (min 8 chars)");
  }
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing[0]) throw new Error("Email already registered");

  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    email,
    displayName: input.displayName.trim() || email.split("@")[0]!,
    role: "USER",
    status: "ACTIVE",
    passwordHash: hashPassword(input.password),
  });
  return {
    id,
    email,
    displayName: input.displayName.trim() || email.split("@")[0]!,
    role: "USER",
    status: "ACTIVE",
  };
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<{ user: AuthUser; cookie: SessionCookie }> {
  const db = await readyDb();
  const email = input.email.trim().toLowerCase();
  const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const row = rows[0];
  if (!row || row.deletedAt || row.status === "SUSPENDED") {
    throw new Error("Invalid credentials");
  }
  if (!row.passwordHash || !verifyPassword(input.password, row.passwordHash)) {
    throw new Error("Invalid credentials");
  }
  const raw = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  await db.insert(schema.authSessions).values({
    id: sessionId,
    userId: row.id,
    sessionTokenHash: hashToken(raw),
    expiresAt: expiresMysql(SESSION_TTL_SEC),
  });
  await db
    .update(schema.users)
    .set({ lastLoginAt: nowMysql() })
    .where(eq(schema.users.id, row.id));

  const user: AuthUser = {
    id: row.id,
    email: row.email ?? email,
    displayName: row.displayName,
    role: row.role === "ADMIN" ? "ADMIN" : "USER",
    status: row.status,
  };
  return {
    user,
    cookie: {
      name: SESSION_COOKIE,
      value: raw,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_SEC,
    },
  };
}

export async function logoutSession(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  const db = await readyDb();
  await db
    .update(schema.authSessions)
    .set({ revokedAt: nowMysql() })
    .where(eq(schema.authSessions.sessionTokenHash, hashToken(rawToken)));
}

export async function getUserFromSessionToken(
  rawToken: string | undefined,
): Promise<AuthUser | null> {
  if (!rawToken) return null;
  const db = await readyDb();
  const rows = await db
    .select({
      userId: schema.authSessions.userId,
      expiresAt: schema.authSessions.expiresAt,
      revokedAt: schema.authSessions.revokedAt,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.users.role,
      status: schema.users.status,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .where(
      and(
        eq(schema.authSessions.sessionTokenHash, hashToken(rawToken)),
        isNull(schema.authSessions.revokedAt),
        gt(schema.authSessions.expiresAt, nowMysql()),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.deletedAt || row.status === "SUSPENDED") return null;
  return {
    id: row.userId,
    email: row.email ?? "",
    displayName: row.displayName,
    role: row.role === "ADMIN" ? "ADMIN" : "USER",
    status: row.status,
  };
}

export function clearSessionCookie(): SessionCookie {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
  };
}
