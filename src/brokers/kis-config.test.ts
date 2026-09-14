import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrokerPublicStatus,
  loadKisConfig,
  parseAccountNo,
  KIS_LIVE_CONFIRM_VALUE,
} from "./kis-config";

test("parseAccountNo accepts dashed and compact forms", () => {
  assert.deepEqual(parseAccountNo("12345678-01"), {
    cano: "12345678",
    productCode: "01",
  });
  assert.deepEqual(parseAccountNo("1234567801"), {
    cano: "12345678",
    productCode: "01",
  });
  assert.deepEqual(parseAccountNo("12345678"), {
    cano: "12345678",
    productCode: "01",
  });
  assert.equal(parseAccountNo("1234"), null);
});

test("real mode stays locked without live confirm", () => {
  const cfg = loadKisConfig({
    KIS_APP_KEY: "key",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NO: "12345678-01",
    KIS_MODE: "real",
  });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.mode, "real");
  assert.equal(cfg.liveEnabled, false);
  assert.ok(cfg.issues.some((msg) => msg.includes("KIS_LIVE_CONFIRM")));
});

test("real mode unlocks only with the exact confirm value", () => {
  const cfg = loadKisConfig({
    KIS_APP_KEY: "key",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NO: "12345678-01",
    KIS_MODE: "real",
    KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
  });
  assert.equal(cfg.liveEnabled, true);
});

test("public status for mock does not leak account numbers", () => {
  const status = getBrokerPublicStatus({ BROKER: "mock" });
  assert.equal(status.driver, "mock");
  assert.equal(status.accountMasked, null);
  assert.match(status.message, /페이퍼/);
});
