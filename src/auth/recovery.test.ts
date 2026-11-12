import assert from "node:assert/strict";
import { test } from "node:test";
import {
  drainMailOutboxForTest,
  mailTransportConfigured,
  sendMail,
} from "@/src/auth/mailer";
import {
  RECOVERY_ACCEPTED_MESSAGE,
  requestFindLoginId,
  requestPasswordReset,
  resetRecoveryRateForTest,
  completePasswordReset,
} from "@/src/auth/recovery";
import { createHash } from "node:crypto";
import { registerUser, loginUser, getUserFromSessionToken } from "@/src/auth/session";
import { getDb, resetDbClientForTest } from "@/src/db/client";
import { loadLocalEnv } from "@/src/db/load-env";
import * as schema from "@/src/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword } from "@/src/auth/password";

loadLocalEnv();

test("mailer uses file sink when SMTP is unset", async () => {
  assert.equal(mailTransportConfigured({}), "file");
  assert.equal(
    mailTransportConfigured({ SMTP_HOST: "smtp.example", MAIL_FROM: "a@b.c" }),
    "smtp",
  );
  drainMailOutboxForTest();
  const result = await sendMail(
    { to: "user@example.com", subject: "t", text: "hello" },
    { MIRAEMAESU_TEST: "1" },
  );
  assert.equal(result.ok, true);
  const box = drainMailOutboxForTest();
  assert.equal(box.length, 1);
  assert.equal(box[0]?.to, "user@example.com");
  assert.equal(box[0]?.text.includes("hello"), true);
});

test("find-id and reset return uniform message; rate limit still uniform", async () => {
  resetRecoveryRateForTest();
  drainMailOutboxForTest();
  const a = await requestFindLoginId({
    email: "nobody-not-registered@example.invalid",
    requestFingerprint: "fp-a",
  });
  assert.equal(a.message, RECOVERY_ACCEPTED_MESSAGE);
  const b = await requestPasswordReset({
    email: "nobody-not-registered@example.invalid",
    requestFingerprint: "fp-a",
  });
  assert.equal(b.message, RECOVERY_ACCEPTED_MESSAGE);
  // No registered user → no mail.
  assert.equal(drainMailOutboxForTest().length, 0);
});

test("password reset stores hash only, consumes token, revokes sessions", async (t) => {
  if (!process.env.DATABASE_URL || !process.env.BROKER_CREDENTIAL_MASTER_KEY) {
    t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
    return;
  }
  resetRecoveryRateForTest();
  drainMailOutboxForTest();

  const email = `reset-${Date.now()}@example.com`;
  const user = await registerUser({
    email,
    password: "OldPassword!1",
    displayName: "Reset User",
  });
  const session = await loginUser({ email, password: "OldPassword!1" });
  assert.equal(session.user.id, user.id);
  assert.ok(await getUserFromSessionToken(session.cookie.value));

  const accepted = await requestPasswordReset({
    email,
    requestFingerprint: `fp-${Date.now()}`,
  });
  assert.equal(accepted.message, RECOVERY_ACCEPTED_MESSAGE);

  const mails = drainMailOutboxForTest();
  assert.equal(mails.length, 1);
  const match = mails[0]?.text.match(/reset-password\?token=([^\s]+)/);
  assert.ok(match?.[1], "reset link must be in mail body");
  const rawToken = decodeURIComponent(match![1]!);

  const db = getDb();
  assert.ok(db);
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const rows = await db
    .select()
    .from(schema.authPasswordResetTokens)
    .where(eq(schema.authPasswordResetTokens.tokenHash, tokenHash))
    .limit(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.userId, user.id);
  // Raw token must never be stored.
  assert.notEqual(rows[0]?.tokenHash, rawToken);

  const completed = await completePasswordReset({
    token: rawToken,
    newPassword: "NewPassword!2",
    confirmPassword: "NewPassword!2",
  });
  assert.equal(completed.userId, user.id);

  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  assert.equal(verifyPassword("NewPassword!2", users[0]!.passwordHash!), true);
  assert.equal(verifyPassword("OldPassword!1", users[0]!.passwordHash!), false);

  // Session revoked.
  assert.equal(await getUserFromSessionToken(session.cookie.value), null);

  // Token consumed — reuse fails.
  await assert.rejects(
    () =>
      completePasswordReset({
        token: rawToken,
        newPassword: "AnotherPass!3",
        confirmPassword: "AnotherPass!3",
      }),
    /Invalid or expired/,
  );

  resetDbClientForTest();
});
