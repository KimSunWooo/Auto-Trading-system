import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrokerPublicStatus,
  getKisConfig,
  KisCredentialError,
  loadKisConfig,
  maskAccountNo,
  parseAccountNo,
  resolveKisEnvironment,
  resolveTradingEnvironment,
  KIS_LIVE_CONFIRM_VALUE,
  KIS_HOSTS,
  KIS_TR,
} from "./kis-config";

const PAPER = {
  KIS_PAPER_APP_KEY: "paper-key",
  KIS_PAPER_APP_SECRET: "paper-secret",
  KIS_PAPER_ACCOUNT_NO: "11111111-01",
} as const;

const REAL = {
  KIS_REAL_APP_KEY: "real-key",
  KIS_REAL_APP_SECRET: "real-secret",
  KIS_REAL_ACCOUNT_NO: "22222222-01",
} as const;

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

test("maskAccountNo hides the full CANO", () => {
  assert.equal(maskAccountNo("12345678", "01"), "******78-01");
});

test("KIS_MODE=demo and paper both select PAPER credentials", () => {
  const demo = loadKisConfig({ KIS_MODE: "demo", ...PAPER, ...REAL });
  const paper = loadKisConfig({ KIS_MODE: "paper", ...PAPER, ...REAL });
  assert.equal(resolveKisEnvironment({ KIS_MODE: "demo" }), "paper");
  assert.equal(demo.environment, "paper");
  assert.equal(paper.environment, "paper");
  assert.equal(demo.appKey, "paper-key");
  assert.equal(paper.appKey, "paper-key");
  assert.equal(demo.host, KIS_HOSTS.paper);
  assert.notEqual(demo.appKey, REAL.KIS_REAL_APP_KEY);
  assert.equal(demo.cano, "11111111");
});

test("KIS_MODE=real selects only REAL credentials", () => {
  const cfg = loadKisConfig({ KIS_MODE: "real", ...PAPER, ...REAL });
  assert.equal(cfg.environment, "real");
  assert.equal(cfg.appKey, "real-key");
  assert.equal(cfg.appSecret, "real-secret");
  assert.equal(cfg.cano, "22222222");
  assert.equal(cfg.host, KIS_HOSTS.real);
  assert.equal(cfg.tokenCacheKey, "kis:token:real");
  assert.notEqual(cfg.appKey, PAPER.KIS_PAPER_APP_KEY);
});

test("real mode stays locked without live confirm", () => {
  const cfg = loadKisConfig({
    KIS_MODE: "real",
    ...REAL,
  });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.mode, "real");
  assert.equal(cfg.liveEnabled, false);
  assert.ok(cfg.issues.some((msg) => msg.includes("KIS_LIVE_CONFIRM")));
});

test("LIVE_TEST cannot unlock real-host orders even with confirm", () => {
  const cfg = loadKisConfig({
    KIS_MODE: "real",
    KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
    TRADING_MODE: "live_test",
    ALLOW_LIVE_TRADING: "true",
    ...REAL,
  });
  assert.equal(cfg.liveEnabled, false);
  assert.ok(cfg.issues.some((msg) => msg.includes("KIS_MODE=paper")));
});

test("real mode unlocks only with live mode, allow flag, and confirm", () => {
  const cfg = loadKisConfig({
    KIS_MODE: "real",
    KIS_LIVE_CONFIRM: KIS_LIVE_CONFIRM_VALUE,
    TRADING_MODE: "live",
    ALLOW_LIVE_TRADING: "true",
    ...REAL,
  });
  assert.equal(cfg.liveEnabled, true);
});

test("getKisConfig PAPER throws when PAPER keys are missing", () => {
  assert.throws(
    () => getKisConfig("paper", { ...REAL }),
    (err: unknown) => err instanceof KisCredentialError && /KIS_PAPER_APP_KEY/.test(err.message),
  );
});

test("getKisConfig PAPER throws when PAPER secret or account is missing", () => {
  assert.throws(
    () =>
      getKisConfig("paper", {
        KIS_PAPER_APP_KEY: "paper-key",
        KIS_REAL_APP_SECRET: "ignored",
      }),
    /KIS_PAPER_APP_SECRET/,
  );
  assert.throws(
    () =>
      getKisConfig("paper", {
        KIS_PAPER_APP_KEY: "paper-key",
        KIS_PAPER_APP_SECRET: "paper-secret",
        KIS_REAL_ACCOUNT_NO: "22222222-01",
      }),
    /KIS_PAPER_ACCOUNT_NO/,
  );
});

test("getKisConfig REAL throws when REAL keys are missing", () => {
  assert.throws(
    () => getKisConfig("real", { ...PAPER }),
    (err: unknown) => err instanceof KisCredentialError && /KIS_REAL_APP_KEY/.test(err.message),
  );
});

test("PAPER does not fall back to REAL credentials", () => {
  assert.throws(() => getKisConfig("paper", { ...REAL }));
  const inspect = loadKisConfig({ KIS_MODE: "paper", ...REAL });
  assert.equal(inspect.configured, false);
  assert.equal(inspect.appKey, "");
  assert.notEqual(inspect.appKey, "real-key");
  assert.equal(inspect.host, KIS_HOSTS.paper);
});

test("REAL does not fall back to PAPER credentials", () => {
  assert.throws(() => getKisConfig("real", { ...PAPER }));
  const inspect = loadKisConfig({ KIS_MODE: "real", ...PAPER });
  assert.equal(inspect.configured, false);
  assert.equal(inspect.appKey, "");
  assert.notEqual(inspect.appKey, "paper-key");
  assert.equal(inspect.host, KIS_HOSTS.real);
});

test("legacy KIS_APP_KEY is ignored and never selected", () => {
  const cfg = loadKisConfig({
    KIS_MODE: "paper",
    KIS_APP_KEY: "legacy-key",
    KIS_APP_SECRET: "legacy-secret",
    KIS_ACCOUNT_NO: "99999999-01",
    ...REAL,
  });
  assert.equal(cfg.configured, false);
  assert.notEqual(cfg.appKey, "legacy-key");
  assert.notEqual(cfg.appKey, "real-key");
  assert.ok(cfg.issues.some((msg) => msg.includes("더 이상")));
});

test("getKisConfig(mock) fails fast without reading credentials", () => {
  assert.throws(
    () => getKisConfig("mock", { ...PAPER, ...REAL }),
    /MockBroker/,
  );
});

test("Mock broker does not need KIS credentials", () => {
  assert.equal(resolveTradingEnvironment({ BROKER: "mock", KIS_MODE: "real", ...REAL }), "mock");
  const status = getBrokerPublicStatus({ BROKER: "mock", ...REAL, ...PAPER });
  assert.equal(status.driver, "mock");
  assert.equal(status.accountMasked, null);
  assert.match(status.message, /페이퍼/);
});

test("public status for mock does not leak account numbers", () => {
  const status = getBrokerPublicStatus({ BROKER: "mock" });
  assert.equal(status.driver, "mock");
  assert.equal(status.accountMasked, null);
  assert.match(status.message, /페이퍼/);
});

test("public status masks PAPER account numbers", () => {
  const status = getBrokerPublicStatus({
    BROKER: "kis",
    KIS_MODE: "paper",
    ...PAPER,
  });
  assert.equal(status.mode, "paper");
  assert.equal(status.accountMasked, "******11-01");
  assert.equal(JSON.stringify(status).includes("11111111"), false);
  assert.equal(JSON.stringify(status).includes("paper-secret"), false);
});

test("cancel TR ids are the KIS revise-cancel codes", () => {
  assert.equal(KIS_TR.cancel.paper, "VTTC0803U");
  assert.equal(KIS_TR.cancel.real, "TTTC0803U");
});

test("open order TR ids are the KIS inquire-daily-ccld 3-month codes", () => {
  assert.equal(KIS_TR.openOrders.paper, "VTTC0081R");
  assert.equal(KIS_TR.openOrders.real, "TTTC0081R");
  assert.equal(KIS_TR.dailyCcld.paper, "VTTC0081R");
  assert.equal(KIS_TR.dailyCcld.real, "TTTC0081R");
  assert.equal(KIS_TR.openOrders.paper, KIS_TR.dailyCcld.paper);
  assert.equal(KIS_TR.openOrders.real, KIS_TR.dailyCcld.real);
});

test("balance TR ids are the KIS inquire-balance codes", () => {
  assert.equal(KIS_TR.balance.paper, "VTTC8434R");
  assert.equal(KIS_TR.balance.real, "TTTC8434R");
});
