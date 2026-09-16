import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import {
  currentStorePath,
  mutateStore,
  persistStateNow,
  resetStateStoreForTest,
} from "@/lib/store";
import { holdsWorkerLock, resetWorkerLockForTest } from "@/src/runtime/worker-lock";
import {
  assertVtsSafeEnv,
  beginVtsTestRun,
  envSnapshotWithoutSecrets,
  finishVtsTestRun,
  makeTestRunId,
  realTradingFlags,
  redactSecrets,
  vtsOrderEligibility,
  vtsOrderTestsEnabled,
  vtsPreflight,
} from "@/src/runtime/vts-harness";

afterEach(() => {
  resetWorkerLockForTest();
  resetStateStoreForTest();
});

test("makeTestRunId follows VTS-YYYYMMDD-HHmmss-short", () => {
  assert.match(makeTestRunId(), /^VTS-\d{8}-\d{6}-[a-z0-9]+$/);
});

test("redactSecrets strips bearer, keys, and account-shaped numbers", () => {
  const raw = "Bearer abc.def authorization appkey=supersecret123 account 12345678-01";
  const redacted = redactSecrets(raw);
  assert.equal(redacted.includes("supersecret123"), false);
  assert.equal(redacted.includes("abc.def"), false);
  assert.match(redacted, /REDACTED/);
});

test("REAL flags abort VTS harness", () => {
  assert.deepEqual(realTradingFlags({}), []);
  assert.throws(
    () =>
      assertVtsSafeEnv({
        KIS_MODE: "real",
        TRADING_MODE: "live_test",
        ALLOW_LIVE_TRADING: "false",
      }),
    /VTS TEST ABORTED/,
  );
});

test("VTS order tests are off by default", () => {
  assert.equal(vtsOrderTestsEnabled({}), false);
  const eligibility = vtsOrderEligibility({
    RUN_KIS_VTS_ORDER_TESTS: "true",
    TRADING_MODE: "live_test",
    KIS_MODE: "paper",
    BROKER: "kis",
  });
  assert.equal(eligibility.ok, false);
  assert.match(eligibility.blocked ?? "", /configured|앱키|KIS/);
});

test("isolated VTS store does not use production paper-account.json", async () => {
  const production = currentStorePath();
  const run = beginVtsTestRun("isolation");
  assert.notEqual(run.statePath, production);
  assert.ok(run.statePath.includes(path.join("data", "vts-test", run.testRunId)));
  await mutateStore((state) => {
    state.settings.autoTrading = false;
    return state;
  });
  assert.equal(existsSync(run.statePath), true);
  finishVtsTestRun(run, "PASS", { layer: "UNIT" });
  assert.equal(currentStorePath(), production);
  const summary = JSON.parse(readFileSync(path.join(run.dir, "test-summary.json"), "utf8")) as {
    outcome: string;
  };
  assert.equal(summary.outcome, "PASS");
});

test("isolated persistStateNow writes VTS ledger, not production paper-account.json", async () => {
  const production = currentStorePath();
  const run = beginVtsTestRun("persist-seam");
  await persistStateNow(createPaperState());
  assert.equal(existsSync(run.statePath), true);
  assert.notEqual(run.statePath, production);
  finishVtsTestRun(run, "PASS", { layer: "UNIT" });
});

test("order preflight blocks when the worker lock is not held", () => {
  const run = beginVtsTestRun("preflight-lock");
  assert.equal(holdsWorkerLock(), false);
  const result = vtsPreflight(createPaperState(), {
    RUN_KIS_VTS_ORDER_TESTS: "true",
    TRADING_MODE: "live_test",
    KIS_MODE: "paper",
    BROKER: "kis",
    KIS_PAPER_APP_KEY: "unit-test-key",
    KIS_PAPER_APP_SECRET: "unit-test-secret",
    KIS_PAPER_ACCOUNT_NO: "12345678-01",
  });
  assert.equal(result.ok, false);
  assert.match(result.blocked ?? "", /worker lock/i);
  finishVtsTestRun(run, "BLOCKED", { layer: "UNIT" });
});

test("env snapshot never includes raw secrets", () => {
  const snap = envSnapshotWithoutSecrets({
    KIS_PAPER_APP_KEY: "should-not-appear",
    KIS_PAPER_APP_SECRET: "should-not-appear",
    KIS_REAL_APP_KEY: "real-should-not-appear",
    KIS_APP_KEY: "legacy-should-not-appear",
    BROKER: "mock",
  });
  const dumped = JSON.stringify(snap);
  assert.equal(dumped.includes("should-not-appear"), false);
  assert.equal(dumped.includes("real-should-not-appear"), false);
  assert.equal(dumped.includes("legacy-should-not-appear"), false);
  assert.equal(snap.KIS_PAPER_APP_KEY, "[REDACTED]");
  assert.equal(snap.KIS_REAL_APP_KEY, "[REDACTED]");
});
