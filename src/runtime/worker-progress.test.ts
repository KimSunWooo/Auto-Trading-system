import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordWorkerProgress,
  resetWorkerProgressForTest,
  workerProgressPublic,
  WORKER_STALL_MS,
} from "@/src/runtime/worker-progress";

test("stalled when stage does not advance beyond WORKER_STALL_MS", () => {
  resetWorkerProgressForTest();
  const row = recordWorkerProgress("acct-test-aaaaaaaa", {
    stage: "persist_start",
    tickId: "t-1",
  });
  const pub = workerProgressPublic(
    { ...row, stageAt: Date.now() - WORKER_STALL_MS - 1 },
    Date.now(),
  );
  assert.equal(pub.stalled, true);
  assert.ok(pub.stallReason?.includes("persist_start"));
});

test("tick_done is not stalled", () => {
  resetWorkerProgressForTest();
  const row = recordWorkerProgress("acct-test-bbbbbbbb", {
    stage: "tick_done",
    tickId: "t-2",
  });
  const pub = workerProgressPublic(row, Date.now());
  assert.equal(pub.stalled, false);
  assert.equal(pub.persistFailed, false);
});
