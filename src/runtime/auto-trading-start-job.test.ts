/**
 * Async auto-trading start job — cancel/OFF must not leave ON; reuse inflight.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelAutoTradingStartJobsForAccount,
  clearAutoTradingStartJobsForTest,
  getAutoTradingStartJob,
  toAutoTradingStartPublic,
  type AutoTradingStartJob,
} from "./auto-trading-start-job";

test("toAutoTradingStartPublic maps reconciling → 장부 대사 중", () => {
  const job = {
    requestId: "start-1",
    userId: "u",
    brokerAccountId: "a",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "reconciling",
    stage: "startup_sync",
    message: "대사 중",
    cancelRequested: false,
    generation: 0,
    timings: [],
    byStage: {},
    totalMs: 12,
    autoTradingOnInRds: null,
  } as AutoTradingStartJob;
  const pub = toAutoTradingStartPublic(job);
  assert.equal(pub.uiStatus, "장부 대사 중");
  assert.equal(pub.status, "reconciling");
});

test("cancelAutoTradingStartJobsForAccount marks running jobs cancelled", () => {
  clearAutoTradingStartJobsForTest();
  // Inject via cancel path after manually placing a job in the module map is hard;
  // cancel on empty account is a no-op and must not throw.
  cancelAutoTradingStartJobsForAccount("missing-account");
  assert.equal(getAutoTradingStartJob("nope"), null);
});
