/**
 * Find-ID + password-reset flows.
 * Never log raw tokens, passwords, or mail credentials.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { hashPassword } from "@/src/auth/password";
import { publicAppOrigin, publicMailDeliveryMode, sendMail } from "@/src/auth/mailer";

export type RecoveryRequestResult = {
  message: string;
  /** Server mail transport — never reveals whether the address is registered. */
  delivery: "smtp" | "local_file";
};

const RESET_TTL_SEC = 60 * 30; // 30 minutes
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 5;

type RateGlobal = typeof globalThis & {
  __miraeRecoveryRate?: Map<string, number[]>;
};
function rateMap(): Map<string, number[]> {
  const g = globalThis as RateGlobal;
  g.__miraeRecoveryRate ??= new Map();
  return g.__miraeRecoveryRate;
}

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

async function readyDb() {
  await ensureAuthSchema();
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL not configured");
  return db;
}

/** Uniform public response — never reveals whether the email is registered. */
export const RECOVERY_ACCEPTED_MESSAGE =
  "요청이 접수되었습니다. 등록된 이메일이면 안내 메일을 보냅니다.";

function allowRate(key: string): boolean {
  const map = rateMap();
  const now = Date.now();
  const prev = (map.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (prev.length >= RATE_MAX_PER_EMAIL) {
    map.set(key, prev);
    return false;
  }
  prev.push(now);
  map.set(key, prev);
  return true;
}

export function resetRecoveryRateForTest(): void {
  rateMap().clear();
}

function recoveryAccepted(): RecoveryRequestResult {
  return {
    message: RECOVERY_ACCEPTED_MESSAGE,
    delivery: publicMailDeliveryMode(),
  };
}

export async function requestFindLoginId(input: {
  email: string;
  requestFingerprint?: string;
}): Promise<RecoveryRequestResult> {
  const email = input.email.trim().toLowerCase();
  const rateKey = `find:${email}:${input.requestFingerprint ?? ""}`;
  if (!allowRate(rateKey)) return recoveryAccepted();

  if (email.includes("@")) {
    try {
      const db = await readyDb();
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      const user = rows[0];
      if (user && !user.deletedAt && user.status === "ACTIVE") {
        await sendMail({
          to: email,
          subject: "[미리매수] 로그인 아이디 안내",
          text: [
            "안녕하세요.",
            "",
            "요청하신 로그인 아이디(이메일)는 아래와 같습니다.",
            "",
            `로그인 아이디: ${email}`,
            "",
            "비밀번호를 잊으셨다면 로그인 화면의 비밀번호 재설정을 이용해 주세요.",
            "",
            "본인이 요청하지 않았다면 이 메일을 무시하세요.",
          ].join("\n"),
        });
      }
    } catch {
      /* swallow — uniform response */
    }
  }
  return recoveryAccepted();
}

export async function requestPasswordReset(input: {
  email: string;
  requestFingerprint?: string;
}): Promise<RecoveryRequestResult> {
  const email = input.email.trim().toLowerCase();
  const rateKey = `reset:${email}:${input.requestFingerprint ?? ""}`;
  if (!allowRate(rateKey)) return recoveryAccepted();

  if (email.includes("@")) {
    try {
      const db = await readyDb();
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      const user = rows[0];
      if (user && !user.deletedAt && user.status === "ACTIVE" && user.passwordHash) {
        const raw = randomBytes(32).toString("base64url");
        const tokenHash = hashToken(raw);
        await db.insert(schema.authPasswordResetTokens).values({
          id: randomUUID(),
          userId: user.id,
          tokenHash,
          expiresAt: expiresMysql(RESET_TTL_SEC),
          requestFingerprint: input.requestFingerprint?.slice(0, 64) ?? null,
        });
        const link = `${publicAppOrigin()}/reset-password?token=${encodeURIComponent(raw)}`;
        await sendMail({
          to: email,
          subject: "[미리매수] 비밀번호 재설정",
          text: [
            "안녕하세요.",
            "",
            "비밀번호 재설정을 요청하셨습니다. 아래 링크는 30분 후 만료되는 일회용 링크입니다.",
            "",
            link,
            "",
            "본인이 요청하지 않았다면 이 메일을 무시하세요.",
          ].join("\n"),
        });
      }
    } catch {
      /* swallow */
    }
  }
  return recoveryAccepted();
}

export async function completePasswordReset(input: {
  token: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<{ ok: true; userId: string }> {
  if (input.newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters");
  }
  if (input.newPassword !== input.confirmPassword) {
    throw new Error("Password confirmation does not match");
  }
  const raw = input.token.trim();
  if (!raw) throw new Error("Invalid or expired reset link");

  const db = await readyDb();
  const tokenHash = hashToken(raw);
  const rows = await db
    .select()
    .from(schema.authPasswordResetTokens)
    .where(
      and(
        eq(schema.authPasswordResetTokens.tokenHash, tokenHash),
        isNull(schema.authPasswordResetTokens.consumedAt),
        gt(schema.authPasswordResetTokens.expiresAt, nowMysql()),
      ),
    )
    .limit(1);
  const token = rows[0];
  if (!token) throw new Error("Invalid or expired reset link");

  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, token.userId))
    .limit(1);
  const user = users[0];
  if (!user || user.deletedAt || user.status === "SUSPENDED") {
    throw new Error("Invalid or expired reset link");
  }

  await db
    .update(schema.users)
    .set({ passwordHash: hashPassword(input.newPassword) })
    .where(eq(schema.users.id, user.id));

  await db
    .update(schema.authPasswordResetTokens)
    .set({ consumedAt: nowMysql() })
    .where(eq(schema.authPasswordResetTokens.id, token.id));

  // Invalidate all login sessions for this user.
  await db
    .update(schema.authSessions)
    .set({ revokedAt: nowMysql() })
    .where(
      and(eq(schema.authSessions.userId, user.id), isNull(schema.authSessions.revokedAt)),
    );

  // Consume any other outstanding reset tokens for the user.
  await db
    .update(schema.authPasswordResetTokens)
    .set({ consumedAt: nowMysql() })
    .where(
      and(
        eq(schema.authPasswordResetTokens.userId, user.id),
        isNull(schema.authPasswordResetTokens.consumedAt),
      ),
    );

  return { ok: true, userId: user.id };
}

/** Peek latest unconsumed raw token from mail outbox is test-only via mailer drain. */
export function passwordResetTtlSec(): number {
  return RESET_TTL_SEC;
}
