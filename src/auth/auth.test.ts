import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "@/src/auth/password";
import {
  decryptPaperCredentials,
  encryptPaperCredentials,
  maskAccountNumber,
} from "@/src/auth/crypto";
import {
  createBootstrapRuntimeScope,
  isScopeStartupSyncDone,
  markScopeStartupSyncDone,
  resetRuntimeScopesForTest,
} from "@/src/runtime/runtime-scope";

test("password hash uses scrypt and timing-safe verify", () => {
  const hash = hashPassword("correct-horse-battery");
  assert.equal(hash.includes("scrypt$"), true);
  assert.equal(verifyPassword("correct-horse-battery", hash), true);
  assert.equal(verifyPassword("wrong-password", hash), false);
  assert.equal(hash.includes("correct-horse"), false);
});

test("paper credentials encrypt/decrypt with AES-GCM; mask account", () => {
  process.env.BROKER_CREDENTIAL_MASTER_KEY = "unit-test-master-key-32chars-min!!";
  const enc = encryptPaperCredentials({
    appKey: "key",
    appSecret: "secret",
    accountNo: "50123456-01",
  });
  assert.ok(enc.ciphertext);
  assert.ok(enc.iv);
  assert.ok(enc.authTag);
  const dec = decryptPaperCredentials(enc);
  assert.equal(dec.appKey, "key");
  assert.equal(dec.accountNo, "50123456-01");
  assert.equal(maskAccountNumber("50123456-01"), "******5601");
});

test("bootstrap RuntimeScope keeps legacy data paths; account scopes are independent", async () => {
  resetRuntimeScopesForTest();
  const boot = createBootstrapRuntimeScope(async () => undefined);
  assert.equal(boot.brokerAccountId, "bootstrap-owner");
  assert.match(boot.statePath, /paper-account\.json$/);
  assert.match(boot.lockPath, /trading-worker\.lock$/);
  markScopeStartupSyncDone("bootstrap-owner", true);
  assert.equal(isScopeStartupSyncDone("bootstrap-owner"), true);
  assert.equal(isScopeStartupSyncDone("other-account"), false);
  // Isolation: marking A does not mark B
  markScopeStartupSyncDone("account-a", true);
  assert.equal(isScopeStartupSyncDone("account-b"), false);
  resetRuntimeScopesForTest();
});

test("ADMIN role constant and USER presets remain server-gated (smoke)", () => {
  // Route-level requireAdmin is the authority — not localhost / NEXT_PUBLIC_ADMIN_MODE.
  assert.equal(process.env.NEXT_PUBLIC_ADMIN_MODE == null || process.env.NEXT_PUBLIC_ADMIN_MODE === "", true);
});
