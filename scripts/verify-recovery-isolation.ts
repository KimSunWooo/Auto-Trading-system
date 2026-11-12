/**
 * Verifies: existing user password reset keeps same userId + PAPER account;
 * two users cannot see each other's broker accounts; PAPER secrets come from DB.
 * Never prints secrets, tokens, or full account numbers.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { drainMailOutboxForTest } from "@/src/auth/mailer";
import {
  completePasswordReset,
  requestFindLoginId,
  requestPasswordReset,
  resetRecoveryRateForTest,
} from "@/src/auth/recovery";
import { loginUser, registerUser } from "@/src/auth/session";
import {
  connectPaperAccount,
  listUserBrokerAccounts,
  loadPaperSecretForAccount,
} from "@/src/auth/paper-accounts";
import { connectRealAccount } from "@/src/auth/real-accounts";
import { selectOwnedPaperAccount } from "@/src/auth/select-paper-account";
import { getDb, resetDbClientForTest } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.BROKER_CREDENTIAL_MASTER_KEY) {
    throw new Error("DATABASE_URL and BROKER_CREDENTIAL_MASTER_KEY required");
  }

  resetRecoveryRateForTest();
  drainMailOutboxForTest();

  const stamp = Date.now();
  const email = `preserve-${stamp}@example.com`;
  const user = await registerUser({
    email,
    password: "PreserveOld!1",
    displayName: "Preserve User",
  });
  const paper = await connectPaperAccount(
    {
      userId: user.id,
      alias: "Preserve PAPER",
      accountNo: `5020${String(stamp).slice(-4)}-01`,
      appKey: "preserve-paper-key",
      appSecret: "preserve-paper-secret",
    },
    { skipLiveValidation: true },
  );

  const findMsg = await requestFindLoginId({ email, requestFingerprint: `v-${stamp}` });
  const findMails = drainMailOutboxForTest();
  console.log("find-id:", {
    uniformMessage: findMsg.message.slice(0, 40),
    mailSent: findMails.length === 1,
    bodyMentionsLoginId: findMails[0]?.text.includes(email) === true,
  });

  await requestPasswordReset({ email, requestFingerprint: `v2-${stamp}` });
  const resetMails = drainMailOutboxForTest();
  const m = resetMails[0]?.text.match(/reset-password\?token=([^\s]+)/);
  if (!m?.[1]) throw new Error("reset token missing from mail sink");
  const raw = decodeURIComponent(m[1]);
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const db = getDb()!;
  const stored = await db
    .select()
    .from(schema.authPasswordResetTokens)
    .where(eq(schema.authPasswordResetTokens.tokenHash, tokenHash))
    .limit(1);
  if (!stored[0] || stored[0].tokenHash === raw) {
    throw new Error("token must be stored hashed only");
  }

  await completePasswordReset({
    token: raw,
    newPassword: "PreserveNew!2",
    confirmPassword: "PreserveNew!2",
  });

  const login = await loginUser({ email, password: "PreserveNew!2" });
  const selected = await selectOwnedPaperAccount(login.user.id);
  const secret = await loadPaperSecretForAccount(selected.id);
  console.log("preserve-after-reset:", {
    sameUserId: login.user.id === user.id,
    samePaperAccountId: selected.id === paper.id,
    paperKeyFromDb: secret?.appKey === "preserve-paper-key",
    notGlobalEnvFallback:
      !process.env.KIS_PAPER_APP_KEY || secret?.appKey !== process.env.KIS_PAPER_APP_KEY,
    kisEnv: secret ? kisConfigFromPaperCredentials(secret).environment : null,
  });

  const u2 = await registerUser({
    email: `other-${stamp}@example.com`,
    password: "OtherPass!12",
    displayName: "Other",
  });
  await connectPaperAccount(
    {
      userId: u2.id,
      alias: "Other PAPER",
      accountNo: `5021${String(stamp).slice(-4)}-01`,
      appKey: "other-paper-key",
      appSecret: "other-paper-secret",
    },
    { skipLiveValidation: true },
  );
  await connectRealAccount(
    {
      userId: u2.id,
      alias: "Other REAL",
      accountNo: `6021${String(stamp).slice(-4)}-01`,
      appKey: "other-real-key",
      appSecret: "other-real-secret",
    },
    { skipLiveValidation: true },
  );

  const aList = await listUserBrokerAccounts(user.id);
  const bList = await listUserBrokerAccounts(u2.id);
  console.log("isolation:", {
    userACount: aList.length,
    userBCount: bList.length,
    crossLeak:
      aList.some((a) => bList.some((b) => b.id === a.id)) ||
      bList.some((b) => aList.some((a) => a.id === b.id)),
    realLockedNote: "REAL connect allowed; orders remain LOCKED at trading gates",
  });

  resetDbClientForTest();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
