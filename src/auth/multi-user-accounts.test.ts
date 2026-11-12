import assert from "node:assert/strict";
import { test } from "node:test";
import { registerUser } from "@/src/auth/session";
import {
  connectPaperAccount,
  listUserBrokerAccounts,
  loadPaperSecretForAccount,
  rotatePaperCredentials,
} from "@/src/auth/paper-accounts";
import {
  connectRealAccount,
  loadRealSecretForUserAccount,
  rotateRealCredentials,
} from "@/src/auth/real-accounts";
import { selectOwnedPaperAccount } from "@/src/auth/select-paper-account";
import { kisConfigFromPaperCredentials, kisConfigFromRealCredentials } from "@/src/brokers/kis-config";
import { loadLocalEnv } from "@/src/db/load-env";
import { resetDbClientForTest } from "@/src/db/client";

loadLocalEnv();

test("kisConfigFromRealCredentials stays read-only (liveEnabled false)", () => {
  const cfg = kisConfigFromRealCredentials({
    appKey: "rk",
    appSecret: "rs",
    accountNo: "12345678-01",
  });
  assert.equal(cfg.environment, "real");
  assert.equal(cfg.liveEnabled, false);
  assert.equal(cfg.host.includes("9443"), true);
});

test("two users isolate PAPER/REAL accounts; PAPER path uses owner DB secrets", async (t) => {
  if (!process.env.DATABASE_URL || !process.env.BROKER_CREDENTIAL_MASTER_KEY) {
    t.skip("DATABASE_URL + BROKER_CREDENTIAL_MASTER_KEY required");
    return;
  }

  const stamp = Date.now();
  const userA = await registerUser({
    email: `iso-a-${stamp}@example.com`,
    password: "IsoPassA!12",
    displayName: "Iso A",
  });
  const userB = await registerUser({
    email: `iso-b-${stamp}@example.com`,
    password: "IsoPassB!12",
    displayName: "Iso B",
  });

  const paperA = await connectPaperAccount(
    {
      userId: userA.id,
      alias: "A PAPER",
      accountNo: `5011${String(stamp).slice(-4)}-01`,
      appKey: "paper-a-key",
      appSecret: "paper-a-secret",
    },
    { skipLiveValidation: true },
  );
  const paperB = await connectPaperAccount(
    {
      userId: userB.id,
      alias: "B PAPER",
      accountNo: `5012${String(stamp).slice(-4)}-01`,
      appKey: "paper-b-key",
      appSecret: "paper-b-secret",
    },
    { skipLiveValidation: true },
  );
  const realA = await connectRealAccount(
    {
      userId: userA.id,
      alias: "A REAL",
      accountNo: `6011${String(stamp).slice(-4)}-01`,
      appKey: "real-a-key",
      appSecret: "real-a-secret",
    },
    { skipLiveValidation: true },
  );
  await connectRealAccount(
    {
      userId: userB.id,
      alias: "B REAL",
      accountNo: `6012${String(stamp).slice(-4)}-01`,
      appKey: "real-b-key",
      appSecret: "real-b-secret",
    },
    { skipLiveValidation: true },
  );

  const listA = await listUserBrokerAccounts(userA.id);
  const listB = await listUserBrokerAccounts(userB.id);
  assert.deepEqual(
    listA.map((a) => a.id).sort(),
    [paperA.id, realA.id].sort(),
  );
  assert.equal(listA.some((a) => a.id === paperB.id), false);
  assert.equal(listB.some((a) => a.id === paperA.id), false);
  assert.equal(listA.filter((a) => a.environment === "PAPER").length, 1);
  assert.equal(listA.filter((a) => a.environment === "REAL").length, 1);

  const selectedA = await selectOwnedPaperAccount(userA.id);
  assert.equal(selectedA.id, paperA.id);
  const secretA = await loadPaperSecretForAccount(selectedA.id);
  assert.ok(secretA);
  assert.equal(secretA.appKey, "paper-a-key");
  const cfgA = kisConfigFromPaperCredentials(secretA);
  assert.equal(cfgA.environment, "paper");
  assert.notEqual(secretA.appKey, process.env.KIS_PAPER_APP_KEY ?? "");

  const realSecretBAttempt = await loadRealSecretForUserAccount(userB.id, realA.id);
  assert.equal(realSecretBAttempt, null);

  await assert.rejects(
    () =>
      rotatePaperCredentials(
        {
          userId: userB.id,
          brokerAccountId: paperA.id,
          accountNo: "99999999-01",
          appKey: "evil",
          appSecret: "evil",
        },
        { skipLiveValidation: true },
      ),
    /not owned/,
  );

  await assert.rejects(
    () =>
      rotateRealCredentials(
        {
          userId: userB.id,
          brokerAccountId: realA.id,
          accountNo: "99999999-01",
          appKey: "evil",
          appSecret: "evil",
        },
        { skipLiveValidation: true },
      ),
    /not owned/,
  );

  // PAPER API path must refuse REAL rows.
  await assert.rejects(
    () =>
      rotatePaperCredentials(
        {
          userId: userA.id,
          brokerAccountId: realA.id,
          accountNo: "60111111-01",
          appKey: "x",
          appSecret: "y",
        },
        { skipLiveValidation: true },
      ),
    /REAL/,
  );

  resetDbClientForTest();
});
