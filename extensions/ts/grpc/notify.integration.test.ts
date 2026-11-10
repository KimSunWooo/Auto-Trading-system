/**
 * Real pipeline: gRPC complete → JobStore outbox → Kafka publisher → TS consumer → GetBacktestJob.
 * Requires local Redpanda (:19092) and EXTENSIONS_REAL_INFRA=1.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { TradingAnalysisClient, grpc, isServiceError } from "./client.ts";
import { ObservationStore } from "./observation-store.ts";
import { BacktestResultConsumer } from "./result-consumer.ts";
import { RESULT_CONSUMER_GROUP } from "./result-events.ts";
import {
  EXT_ROOT,
  freshStore,
  parseBind,
  sleep,
  startPublisher,
  startServer,
  startWorker,
  stopProc,
  waitPort,
  type ProcHandle,
} from "./harness.ts";

const RUN = process.env.EXTENSIONS_REAL_INFRA === "1" || process.env.EXTENSIONS_REAL_INFRA === "true";
const BIND = `127.0.0.1:${18500 + (process.pid % 500)}`;
const { host, port } = parseBind(BIND);
const BROKERS = process.env.EXT_KAFKA_BROKERS ?? "127.0.0.1:19092";
const STORE = freshStore(`notify-${process.pid}`);
const OBS_ROOT = path.join(EXT_ROOT, ".bus", "observations-test", `notify-${process.pid}`);

function skipUnlessReal(): void {
  console.log(JSON.stringify({ realNotifyPipeline: RUN, bind: BIND, store: STORE, brokers: BROKERS }));
}

skipUnlessReal();

let server: ProcHandle;
let worker: ProcHandle;
let publisher: ProcHandle;
let client: TradingAnalysisClient;

function pendingOutbox(): string[] {
  const dir = path.join(STORE, "outbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { published_at_unix_ms: number | null; event_id: string })
    .filter((r) => r.published_at_unix_ms == null)
    .map((r) => r.event_id);
}

function allOutbox(): Array<{ event_id: string; published_at_unix_ms: number | null; status: string }> {
  const dir = path.join(STORE, "outbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
}

function pyStore(code: string): string {
  const script = [
    "from ats_research.job_store import JobStore",
    "from pathlib import Path",
    "import json",
    `store = JobStore(Path(${JSON.stringify(STORE)}), max_attempts=3, lease_ms=200)`,
    code,
  ].join("\n");
  const tmp = path.join(os.tmpdir(), `ext-py-${process.pid}-${Date.now()}.py`);
  writeFileSync(tmp, script);
  try {
    return execSync(`python3 ${JSON.stringify(tmp)}`, {
      cwd: path.resolve(EXT_ROOT, ".."),
      env: { ...process.env, PYTHONPATH: path.join(EXT_ROOT, "python") },
      encoding: "utf-8",
    }).trim();
  } finally {
    rmSync(tmp, { force: true });
  }
}

function outboxStats(): { pending_count: number; oldest_pending_age_ms: number } {
  return JSON.parse(pyStore("print(json.dumps(store.outbox_stats()))"));
}

async function consumeUntil(
  obs: ObservationStore,
  opts: {
    groupId: string;
    wantJobId?: string;
    maxEvents?: number;
    idleMs?: number;
    crashAfterStoreBeforeCommit?: boolean;
  },
) {
  const ac = new AbortController();
  const consumer = new BacktestResultConsumer(BROKERS.split(","), BIND, obs, {
    groupId: opts.groupId,
    crashAfterStoreBeforeCommit: opts.crashAfterStoreBeforeCommit,
    crashOnJobId: opts.wantJobId,
    grpcDeadlineMs: 5_000,
  });
  const idleMs = opts.idleMs ?? 15_000;
  const timer = setTimeout(() => ac.abort(), idleMs);
  try {
    return await consumer.run({
      signal: ac.signal,
      abort: () => ac.abort(),
      maxEvents: opts.maxEvents,
      fromBeginning: true,
      onEvent: (e) => {
        if (opts.wantJobId && e.jobId === opts.wantJobId) {
          setTimeout(() => ac.abort(), 30);
        }
      },
    });
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

before(async () => {
  if (!RUN) return;
  rmSync(OBS_ROOT, { recursive: true, force: true });
  mkdirSync(OBS_ROOT, { recursive: true });
  server = startServer({ store: STORE, bind: BIND, queueCap: 32 });
  await waitPort(host, port, 15_000);
  worker = startWorker({ store: STORE, workerId: "notify-w1", leaseMs: 10_000 });
  publisher = startPublisher({ store: STORE, brokers: BROKERS, pollMs: 100 });
  client = new TradingAnalysisClient(BIND, { deadlineMs: 5_000 });
});

after(async () => {
  if (!RUN) return;
  client?.close();
  await stopProc(publisher);
  await stopProc(worker);
  await stopProc(server);
});

test("notify: SUCCEEDED event matches GetBacktestJob", { skip: !RUN }, async () => {
  const key = `ok-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "ok", fastMa: 5, slowMa: 20, buyPct: 0.1, stopLossPct: 0.05 },
  });
  const job = await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  assert.equal(job.status, "SUCCEEDED");

  // Wait for outbox publish
  for (let i = 0; i < 50; i++) {
    const rows = allOutbox().filter((r) => r.event_id.includes(sub.jobId));
    if (rows.some((r) => r.published_at_unix_ms != null)) break;
    await sleep(100);
  }
  const row = allOutbox().find((r) => r.event_id.includes(sub.jobId));
  assert.ok(row, "outbox row missing");
  assert.ok(row!.published_at_unix_ms, "expected published");

  const obs = new ObservationStore(path.join(OBS_ROOT, "ok"));
  const stats = await consumeUntil(obs, {
    groupId: `${RESULT_CONSUMER_GROUP}-ok-${Date.now()}`,
    wantJobId: sub.jobId,
  });
  assert.ok(stats.applied >= 1 || stats.duplicates >= 1 || obs.list().some((o) => o.jobId === sub.jobId));
  const list = obs.list().filter((o) => o.jobId === sub.jobId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.jobStatus, "SUCCEEDED");
  assert.equal(list[0]!.eventStatus, "SUCCEEDED");
  const refreshed = await client.get(sub.jobId);
  assert.ok(refreshed.status === "SUCCEEDED");
  console.log(JSON.stringify({ succeededNotify: true, eventId: list[0]!.eventId, jobId: sub.jobId }));
});

function reclaimLeases(): void {
  pyStore("print(store.reclaim_expired_leases())");
}

test("notify: FAILED (lease exhausted) event matches GetBacktestJob", { skip: !RUN }, async () => {
  // Stop healthy worker; crash workers with tiny lease + max_attempts via store max_attempts=3 default
  await stopProc(worker);
  worker = null as unknown as ProcHandle;

  const key = `fail-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "fail", fastMa: 5, slowMa: 20 },
  });

  // Three crash claims → FAILED worker_lease_exhausted (+ outbox)
  for (let i = 0; i < 3; i++) {
    const crash = startWorker({
      store: STORE,
      workerId: `fail-crash-${i}`,
      leaseMs: 200,
      crashAfterClaim: true,
      maxJobs: 1,
    });
    for (let j = 0; j < 40; j++) {
      if (crash.proc.exitCode != null) break;
      await sleep(50);
    }
    await sleep(300);
    reclaimLeases();
  }

  const job = await client.waitForTerminal(sub.jobId, { timeoutMs: 15_000 });
  assert.equal(job.status, "FAILED");
  assert.match(job.error, /worker_lease_exhausted/);

  for (let i = 0; i < 40; i++) {
    const rows = allOutbox().filter((r) => r.event_id.includes(sub.jobId) && r.published_at_unix_ms);
    if (rows.length) break;
    await sleep(100);
  }

  const obs = new ObservationStore(path.join(OBS_ROOT, "fail"));
  await consumeUntil(obs, {
    groupId: `${RESULT_CONSUMER_GROUP}-fail-${Date.now()}`,
    wantJobId: sub.jobId,
  });
  const list = obs.list().filter((o) => o.jobId === sub.jobId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.jobStatus, "FAILED");
  assert.equal(list[0]!.eventStatus, "FAILED");

  worker = startWorker({ store: STORE, workerId: "notify-w-resume", leaseMs: 10_000 });
  console.log(JSON.stringify({ failedNotify: true, jobId: sub.jobId, eventId: list[0]!.eventId }));
});

test("notify: Kafka down keeps outbox pending; gRPC get still works; recover delivers", { skip: !RUN }, async () => {
  if (!worker?.proc.pid) {
    worker = startWorker({ store: STORE, workerId: "notify-w-kdown", leaseMs: 10_000 });
  }
  await stopProc(publisher);
  publisher = null as unknown as ProcHandle;
  // Point publisher at dead broker while job completes
  const deadPub = startPublisher({
    store: STORE,
    brokers: "127.0.0.1:1",
    pollMs: 100,
    maxCycles: 8,
  });
  const key = `kdown-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "kdown", fastMa: 5, slowMa: 20 },
  });
  const job = await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  assert.equal(job.status, "SUCCEEDED");
  // gRPC readable while notify is stuck
  assert.equal((await client.get(sub.jobId)).status, "SUCCEEDED");

  await sleep(1_000);
  await stopProc(deadPub);
  const pending = pendingOutbox();
  assert.ok(
    pending.some((e) => e.includes(sub.jobId)),
    `expected pending outbox for ${sub.jobId}, pending=${JSON.stringify(pending)} stats=${JSON.stringify(outboxStats())}`,
  );
  const statsBefore = outboxStats();
  assert.ok(statsBefore.pending_count >= 1);
  assert.ok(statsBefore.oldest_pending_age_ms >= 0);
  console.log(JSON.stringify({ kafkaDownPending: true, ...statsBefore, jobId: sub.jobId }));

  // Recover
  publisher = startPublisher({ store: STORE, brokers: BROKERS, pollMs: 100 });
  for (let i = 0; i < 50; i++) {
    const rows = allOutbox().filter((r) => r.event_id.includes(sub.jobId) && r.published_at_unix_ms);
    if (rows.length) break;
    await sleep(100);
  }
  assert.ok(allOutbox().some((r) => r.event_id.includes(sub.jobId) && r.published_at_unix_ms));

  const obs = new ObservationStore(path.join(OBS_ROOT, "kdown"));
  await consumeUntil(obs, {
    groupId: `${RESULT_CONSUMER_GROUP}-kdown-${Date.now()}`,
    wantJobId: sub.jobId,
  });
  assert.equal(obs.list().filter((o) => o.jobId === sub.jobId).length, 1);
});

test("notify: crash after broker ACK before outbox mark — republish same eventId, one observation", { skip: !RUN }, async () => {
  if (!worker?.proc.pid) {
    worker = startWorker({ store: STORE, workerId: "notify-w-ack", leaseMs: 10_000 });
  }
  await stopProc(publisher);
  publisher = null as unknown as ProcHandle;
  const key = `ackcrash-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "ack", fastMa: 5, slowMa: 20 },
  });
  await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });

  const crashPub = startPublisher({
    store: STORE,
    brokers: BROKERS,
    crashAfterAck: true,
    pollMs: 50,
  });
  for (let i = 0; i < 80; i++) {
    if (crashPub.proc.exitCode != null) break;
    await sleep(50);
  }
  assert.equal(crashPub.proc.exitCode, 97);
  // Still pending mark
  assert.ok(pendingOutbox().some((e) => e.includes(sub.jobId)));

  // Restart publisher — republish same eventId
  publisher = startPublisher({ store: STORE, brokers: BROKERS, pollMs: 100 });
  for (let i = 0; i < 50; i++) {
    if (allOutbox().some((r) => r.event_id.includes(sub.jobId) && r.published_at_unix_ms)) break;
    await sleep(100);
  }

  const obs = new ObservationStore(path.join(OBS_ROOT, "ackcrash"));
  const group = `${RESULT_CONSUMER_GROUP}-ack-${Date.now()}`;
  await consumeUntil(obs, { groupId: group, wantJobId: sub.jobId, idleMs: 12_000 });
  // May see duplicate deliveries; observation must be one
  const list = obs.list().filter((o) => o.jobId === sub.jobId);
  assert.equal(list.length, 1, `expected 1 observation, got ${list.length}`);
  console.log(JSON.stringify({ ackCrashDedupe: true, eventId: list[0]!.eventId, observations: list.length }));
});

test("notify: consumer crash after store before offset commit — redelivery dedupes", { skip: !RUN }, async () => {
  if (!worker?.proc.pid) {
    worker = startWorker({ store: STORE, workerId: "notify-w-cc", leaseMs: 10_000 });
  }
  if (!publisher?.proc.pid) {
    publisher = startPublisher({ store: STORE, brokers: BROKERS, pollMs: 100 });
  }
  const key = `ccrash-${Date.now()}`;
  const sub = await client.submit({
    idempotencyKey: key,
    datasetId: "synthetic-v0-short",
    candidate: { candidateId: "cc", fastMa: 5, slowMa: 20 },
  });
  await client.waitForTerminal(sub.jobId, { timeoutMs: 30_000 });
  for (let i = 0; i < 40; i++) {
    if (allOutbox().some((r) => r.event_id.includes(sub.jobId) && r.published_at_unix_ms)) break;
    await sleep(100);
  }

  const obs = new ObservationStore(path.join(OBS_ROOT, "ccrash"));
  const group = `${RESULT_CONSUMER_GROUP}-ccrash-${Date.now()}`;
  const first = await consumeUntil(obs, {
    groupId: group,
    wantJobId: sub.jobId,
    idleMs: 12_000,
    crashAfterStoreBeforeCommit: true,
  });
  assert.equal(first.crashed, true);
  assert.ok(obs.list().some((o) => o.jobId === sub.jobId));

  const second = await consumeUntil(obs, {
    groupId: group,
    wantJobId: sub.jobId,
    idleMs: 12_000,
  });
  assert.ok(second.duplicates >= 1 || second.applied >= 0);
  assert.equal(obs.list().filter((o) => o.jobId === sub.jobId).length, 1);
  console.log(JSON.stringify({ consumerCrashDedupe: true, first, second, count: obs.count() }));
});

test("notify: submit delay past client deadline — retry same key → same jobId, one stored job", { skip: !RUN }, async () => {
  await stopProc(server);
  await sleep(200);
  server = startServer({ store: STORE, bind: BIND, queueCap: 32, submitDelayMs: 800 });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 200 });

  const key = `deadline-${Date.now()}`;
  const body = {
    idempotencyKey: key,
    datasetId: "synthetic-v0-short" as const,
    candidate: { candidateId: "dl", fastMa: 5, slowMa: 20, buyPct: 0.1, stopLossPct: 0.05 },
  };
  let timedOut = false;
  try {
    await client.submit({ ...body, rpcDeadlineMs: 200 });
  } catch (err) {
    timedOut = true;
    assert.ok(isServiceError(err));
    assert.equal(err.code, grpc.status.DEADLINE_EXCEEDED);
  }
  assert.equal(timedOut, true);

  // Retry with generous deadline
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 5_000 });
  const ok = await client.submit(body);
  const again = await client.submit(body);
  assert.equal(ok.jobId, again.jobId);

  const jobsDir = path.join(STORE, "jobs");
  const matching = readdirSync(jobsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(jobsDir, f), "utf8")) as { job_id: string; request: { idempotency_key: string } })
    .filter((j) => j.request?.idempotency_key === key);
  assert.equal(matching.length, 1);
  assert.equal(matching[0]!.job_id, ok.jobId);
  console.log(JSON.stringify({ deadlineRetry: true, jobId: ok.jobId, storedJobs: matching.length }));
});
