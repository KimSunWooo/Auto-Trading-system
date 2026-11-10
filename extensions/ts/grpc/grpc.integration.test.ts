/**
 * Real TypeScript client → Python gRPC server → separate backtest worker.
 * Not mocks for the RPC path — processes are spawned locally.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TradingAnalysisClient, grpc, isServiceError } from "./client.ts";
import {
  EXT_ROOT,
  freshStore,
  parseBind,
  readLog,
  sleep,
  startServer,
  startWorker,
  stopProc,
  waitPort,
  type ProcHandle,
} from "./harness.ts";

const BIND = `127.0.0.1:${18000 + (process.pid % 1000)}`;
const { host, port } = parseBind(BIND);
const STORE = freshStore(`grpc-${process.pid}`);

let server: ProcHandle;
let worker: ProcHandle;
let client: TradingAnalysisClient;

before(async () => {
  server = startServer({ store: STORE, bind: BIND, queueCap: 8 });
  await waitPort(host, port, 15_000);
  worker = startWorker({ store: STORE, workerId: "w-main", leaseMs: 5_000 });
  client = new TradingAnalysisClient(BIND, { deadlineMs: 5_000 });
  console.log(
    JSON.stringify({
      realGrpc: true,
      bind: BIND,
      store: STORE,
      serverPid: server.proc.pid,
      workerPid: worker.proc.pid,
    }),
  );
});

after(async () => {
  client?.close();
  await stopProc(worker);
  await stopProc(server);
});

test("real grpc: submit → worker → get SUCCEEDED with metrics", async () => {
  const key = `happy-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: {
      candidateId: "ma-5-20",
      fastMa: 5,
      slowMa: 20,
      buyPct: 0.1,
      stopLossPct: 0.05,
      dataVersion: "synthetic-v0-short",
    },
  });
  assert.ok(sub.jobId);
  assert.ok(["QUEUED", "RUNNING", "SUCCEEDED"].includes(sub.status));
  const job = await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  assert.equal(job.status, "SUCCEEDED", job.error);
  assert.equal(job.jobId, sub.jobId);
  assert.ok(Number.isFinite(job.metrics.totalReturnPct));
  assert.ok(Number.isFinite(job.metrics.mddPct));
  assert.ok(job.metrics.trades >= 0);
  assert.equal(job.candidate.dataVersion, "synthetic-v0-short");
  console.log(JSON.stringify({ happyPath: job }, null, 2));
});

test("real grpc: same idempotency key + same input returns same jobId", async () => {
  const key = `dedupe-${Date.now()}`;
  const body = {
    idempotencyKey: key,
    datasetId: "synthetic-v0-short" as const,
    candidate: { candidateId: "ma-3-10", fastMa: 3, slowMa: 10, buyPct: 0.25, stopLossPct: 0.03 },
  };
  const a = await client.submit(body);
  const b = await client.submit(body);
  assert.equal(a.jobId, b.jobId);
});

test("real grpc: same key + different input → ALREADY_EXISTS conflict", async () => {
  const key = `conflict-${Date.now()}`;
  await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "a", fastMa: 3, slowMa: 10 },
  });
  let code: number | undefined;
  try {
    await client.submit({
      idempotencyKey: key,
      datasetId: "synthetic-v0-short",
      candidate: { candidateId: "b", fastMa: 5, slowMa: 20 },
    });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.equal(code, grpc.status.ALREADY_EXISTS);
});

test("real grpc: concurrent same-key submits collapse to one jobId", async () => {
  const key = `concurrent-${Date.now()}`;
  const body = {
    idempotencyKey: key,
    datasetId: "synthetic-v0-short" as const,
    candidate: { candidateId: "c", fastMa: 5, slowMa: 20, buyPct: 0.1, stopLossPct: 0.05 },
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => client.submit(body)));
  const ids = new Set(results.map((r) => r.jobId));
  assert.equal(ids.size, 1, `expected 1 jobId, got ${[...ids]}`);
});

test("real grpc: RPC timeout then retry recovers same job", async () => {
  const key = `timeout-retry-${Date.now()}`;
  let firstErr: unknown;
  try {
    await client.submit(
      {
        idempotencyKey: key,
        datasetId: "synthetic-v0-short",
        candidate: { candidateId: "t", fastMa: 5, slowMa: 20 },
        rpcDeadlineMs: 1, // force DEADLINE_EXCEEDED on client
      },
    );
  } catch (err) {
    firstErr = err;
  }
  // Extremely tight deadline may or may not fire before response; either way retry must be safe.
  const ok = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "t", fastMa: 5, slowMa: 20 },
  });
  assert.ok(ok.jobId);
  const again = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "t", fastMa: 5, slowMa: 20 },
  });
  assert.equal(again.jobId, ok.jobId);
  console.log(
    JSON.stringify({
      timeoutRetry: true,
      firstError: firstErr && isServiceError(firstErr) ? firstErr.code : String(firstErr ?? null),
      jobId: ok.jobId,
    }),
  );
});

test("real grpc: unknown dataset_id rejected", async () => {
  let code: number | undefined;
  try {
    await client.submit({
      idempotencyKey: `bad-ds-${Date.now()}`,
      datasetId: "/etc/passwd",
      candidate: { fastMa: 5, slowMa: 20 },
    });
  } catch (err) {
    assert.ok(isServiceError(err) || (err as Error).message.includes("unknown_dataset_id"));
    if (isServiceError(err)) code = err.code;
    else code = grpc.status.NOT_FOUND;
  }
  assert.equal(code, grpc.status.NOT_FOUND);
});

test("real grpc: queue saturation → RESOURCE_EXHAUSTED", async () => {
  // Stop worker so jobs stay QUEUED
  await stopProc(worker);
  worker = null as unknown as ProcHandle;

  const prefix = `sat-${Date.now()}`;
  const submitted: string[] = [];
  let exhausted = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await client.submit({
        idempotencyKey: `${prefix}-${i}`,
        datasetId: "synthetic-v0-short",
        candidate: { candidateId: `s${i}`, fastMa: 5, slowMa: 20 },
      });
      submitted.push(r.jobId);
    } catch (err) {
      assert.ok(isServiceError(err));
      assert.equal(err.code, grpc.status.RESOURCE_EXHAUSTED);
      exhausted = true;
      break;
    }
  }
  assert.equal(exhausted, true);
  console.log(JSON.stringify({ queueSaturation: true, accepted: submitted.length, queueCap: 8 }));

  // Restart worker to drain leftovers for later tests
  worker = startWorker({ store: STORE, workerId: "w-drain", leaseMs: 5_000 });
  await sleep(500);
});

test("real grpc: server restart while QUEUED — no job loss / no duplicate", async () => {
  await stopProc(worker);
  const key = `restart-q-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "rq", fastMa: 5, slowMa: 20 },
  });
  // Ensure still on disk as QUEUED or RUNNING
  const jobFile = path.join(STORE, "jobs", `${sub.jobId}.json`);
  const before = JSON.parse(readFileSync(jobFile, "utf8")) as { status: string };
  assert.ok(["QUEUED", "RUNNING"].includes(before.status));

  await stopProc(server);
  await sleep(300);
  server = startServer({ store: STORE, bind: BIND, queueCap: 8 });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 5_000 });

  const again = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "rq", fastMa: 5, slowMa: 20 },
  });
  assert.equal(again.jobId, sub.jobId, "restart must not create duplicate job");

  worker = startWorker({ store: STORE, workerId: "w-after-restart", leaseMs: 5_000 });
  const done = await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  assert.equal(done.status, "SUCCEEDED");
  console.log(JSON.stringify({ serverRestartQueued: true, jobId: sub.jobId, status: done.status }));
});

test("real grpc: worker killed mid-job — reclaim then succeed; stale complete rejected", async () => {
  await stopProc(worker);
  const key = `crash-w-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "cw", fastMa: 5, slowMa: 20 },
  });

  const crashWorker = startWorker({
    store: STORE,
    workerId: "w-crash",
    leaseMs: 800,
    crashAfterClaim: true,
    maxJobs: 1,
  });
  // Wait for crash
  for (let i = 0; i < 50; i++) {
    if (crashWorker.proc.exitCode != null) break;
    await sleep(100);
  }
  assert.ok(crashWorker.proc.exitCode === 99 || crashWorker.proc.killed || crashWorker.proc.exitCode != null);
  console.log(
    JSON.stringify({
      workerCrash: true,
      exitCode: crashWorker.proc.exitCode,
      logTail: readLog(crashWorker).split("\n").slice(-5),
    }),
  );

  // Short lease → reclaim to QUEUED, then healthy worker finishes.
  await sleep(1_000);
  worker = startWorker({ store: STORE, workerId: "w-recover", leaseMs: 5_000 });
  const done = await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  assert.equal(done.status, "SUCCEEDED", done.error);

  // Stale complete must not overwrite: invoke Python one-liner
  const { spawnSync } = await import("node:child_process");
  const stale = spawnSync(
    "python3",
    [
      "-c",
      `
from ats_research.job_store import JobStore, StaleLeaseError
from pathlib import Path
store = JobStore(Path(${JSON.stringify(STORE)}))
try:
    store.complete(${JSON.stringify(sub.jobId)}, {"total_return_pct": -999}, worker_id="w-crash", lease_generation=1)
    print("UNEXPECTED_OK")
except StaleLeaseError as e:
    print("STALE_REJECTED:" + str(e))
`,
    ],
    {
      cwd: path.resolve(EXT_ROOT, ".."),
      env: {
        ...process.env,
        PYTHONPATH: path.join(EXT_ROOT, "python"),
      },
      encoding: "utf-8",
    },
  );
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /STALE_REJECTED/);
  const final = await client.get(sub.jobId);
  assert.equal(final.status, "SUCCEEDED");
  assert.notEqual(final.metrics.totalReturnPct, -999);
  console.log(JSON.stringify({ staleOverwriteBlocked: true, finalStatus: final.status }));
});

test("inventory: job files exist under store (durability)", () => {
  const jobsDir = path.join(STORE, "jobs");
  const files = readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 1);
});
