import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLocalEnv } from "@/src/db/load-env";
import { resetDbClientForTest } from "@/src/db/client";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";
import { registerUser } from "@/src/auth/session";
import { connectPaperAccount } from "@/src/auth/paper-accounts";
import {
  getUserAccountBindings,
  setUserPreferredBrokerAccount,
} from "@/src/auth/user-account-prefs";
import { selectOwnedPaperAccount } from "@/src/auth/select-paper-account";

loadLocalEnv();

test("user paper preference is set on connect and used for selection", async (t) => {
  if (!process.env.DATABASE_URL || !process.env.BROKER_CREDENTIAL_MASTER_KEY) {
    t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
    return;
  }
  await ensureAuthSchema();
  const stamp = Date.now();
  const user = await registerUser({
    email: `pref-${stamp}@example.com`,
    password: "PrefPass!12",
    displayName: "Pref",
  });
  const paper = await connectPaperAccount(
    {
      userId: user.id,
      alias: "Pref PAPER",
      accountNo: `5033${String(stamp).slice(-4)}-01`,
      appKey: "pref-key",
      appSecret: "pref-secret",
    },
    { skipLiveValidation: true },
  );
  const bindings = await getUserAccountBindings(user.id);
  assert.equal(bindings.paper.brokerAccountId, paper.id);
  assert.equal(bindings.paper.appKeyRegistered, true);
  assert.equal(bindings.paper.credentialsDecryptOk, true);
  assert.equal(bindings.paper.keyVersion, "v1");
  assert.equal(bindings.real.brokerAccountId, null);

  const selected = await selectOwnedPaperAccount(user.id);
  assert.equal(selected.id, paper.id);

  await assert.rejects(
    () =>
      setUserPreferredBrokerAccount({
        userId: user.id,
        environment: "PAPER",
        brokerAccountId: "00000000-0000-0000-0000-000000000000",
      }),
    /not owned/,
  );

  resetDbClientForTest();
});
