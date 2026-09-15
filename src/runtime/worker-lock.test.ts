import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  resetWorkerLockForTest,
  tryAcquireWorkerLock,
  heartbeatWorkerLock,
  releaseWorkerLock,
  holdsWorkerLock,
} from "./worker-lock";

afterEach(() => resetWorkerLockForTest());

test("second worker cannot steal a live lock", () => {
  const filePath = path.join(tmpdir(), `wl-${Date.now()}.lock`);
  assert.equal(tryAcquireWorkerLock("one", { filePath, ttlMs: 60_000 }), true);
  assert.equal(holdsWorkerLock("one"), true);
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock("two", { filePath, ttlMs: 60_000 }), false);
  assert.equal(holdsWorkerLock("two"), false);
});

test("heartbeat fails after another worker is recorded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wl-"));
  const filePath = path.join(dir, "trading-worker.lock");
  assert.equal(tryAcquireWorkerLock("one", { filePath, ttlMs: 60_000 }), true);
  await writeFile(
    filePath,
    JSON.stringify({ workerId: "two", pid: 1, lockedAt: Date.now(), heartbeatAt: Date.now() }),
    "utf8",
  );
  assert.equal(heartbeatWorkerLock({ ttlMs: 60_000 }), false);
  releaseWorkerLock("one");
});
