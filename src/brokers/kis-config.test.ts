import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrokerPublicStatus,
  loadKisConfig,
  parseAccountNo,
  KIS_LIVE_CONFIRM_VALUE,
  KIS_TR,
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

test("LIVE_TEST cannot unlock real-host orders even with confirm", () => {
  const cfg = loadKisConfig({
    KIS_APP_KEY: "key",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NO: "12345678-01",
    KIS_MODE: "real",
    KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
    TRADING_MODE: "live_test",
    ALLOW_LIVE_TRADING: "true",
  });
  assert.equal(cfg.liveEnabled, false);
  assert.ok(cfg.issues.some((msg) => msg.includes("KIS_MODE=demo")));
});

test("real mode unlocks only with live mode, allow flag, and confirm", () => {
  const cfg = loadKisConfig({
    KIS_APP_KEY: "key",
    KIS_APP_SECRET: "secret",
    KIS_ACCOUNT_NO: "12345678-01",
    KIS_MODE: "real",
    KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
    TRADING_MODE: "live",
    ALLOW_LIVE_TRADING: "true",
  });
  assert.equal(cfg.liveEnabled, true);
});

test("public status for mock does not leak account numbers", () => {
  const status = getBrokerPublicStatus({ BROKER: "mock" });
  assert.equal(status.driver, "mock");
  assert.equal(status.accountMasked, null);
  assert.match(status.message, /페이퍼/);
});

test("cancel TR ids are the KIS revise-cancel codes", () => {
  assert.equal(KIS_TR.cancel.demo, "VTTC0803U");
  assert.equal(KIS_TR.cancel.real, "TTTC0803U");
});

test("open order TR ids are the KIS inquire-nccs codes", () => {
  assert.equal(KIS_TR.openOrders.demo, "VTTC8438R");
  assert.equal(KIS_TR.openOrders.real, "TTTC8438R");
});

test("balance TR ids are the KIS inquire-balance codes", () => {
  assert.equal(KIS_TR.balance.demo, "VTTC8434R");
  assert.equal(KIS_TR.balance.real, "TTTC8434R");
});
