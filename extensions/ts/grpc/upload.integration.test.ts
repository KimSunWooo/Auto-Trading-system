/**
 * Real UploadBars streaming → catalog → SubmitBacktest → notify/result path.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TradingAnalysisClient, grpc, isServiceError } from "./client.ts";
import { readOhlcvJsonl, type OhlcvBar } from "./ohlcv-file.ts";
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

const BIND = `127.0.0.1:${18600 + (process.pid % 400)}`;
const { host, port } = parseBind(BIND);
const BROKERS = process.env.EXT_KAFKA_BROKERS ?? "127.0.0.1:19092";
const STORE = freshStore(`upload-${process.pid}`);
const FIXTURE = path.join(EXT_ROOT, "fixtures/ohlcv-005930-1d.jsonl");

let server: ProcHandle;
let worker: ProcHandle;
let publisher: ProcHandle;
let client: TradingAnalysisClient;
let fixtureBars: OhlcvBar[] = [];

async function loadFixture(): Promise<OhlcvBar[]> {
  const out: OhlcvBar[] = [];
  for await (const b of readOhlcvJsonl(FIXTURE)) out.push(b);
  return out;
}

function tempDirs(): string[] {
  const d = path.join(STORE, "datasets", "tmp");
  if (!existsSync(d)) return [];
  return readdirSync(d);
}

function catalogIds(): string[] {
  const idx = path.join(STORE, "datasets", "catalog.json");
  if (!existsSync(idx)) return [];
  return Object.keys(JSON.parse(readFileSync(idx, "utf8")) as Record<string, unknown>);
}

before(async () => {
  fixtureBars = await loadFixture();
  assert.ok(fixtureBars.length >= 20, "fixture too small");
  server = startServer({ store: STORE, bind: BIND, queueCap: 32 });
  await waitPort(host, port, 15_000);
  worker = startWorker({ store: STORE, workerId: "upload-w1", leaseMs: 15_000 });
  publisher = startPublisher({ store: STORE, brokers: BROKERS, pollMs: 100 });
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000, uploadSendBuffer: 2 });
  console.log(
    JSON.stringify({
      realUpload: true,
      bind: BIND,
      store: STORE,
      fixtureBars: fixtureBars.length,
      publisher: "python outbox_publisher / kafka-python-ng",
      tsKafka: "kafkajs consumers",
    }),
  );
});

after(async () => {
  client?.close();
  await stopProc(publisher);
  await stopProc(worker);
  await stopProc(server);
});

test("upload: multi-batch RPC → SubmitBacktest → notify dataVersion match", async () => {
  const uploaded = await client.uploadBars({
    bars: fixtureBars,
    ticker: "005930",
    interval: "1d",
    batchSize: 7,
    sendBuffer: 2,
    rpcDeadlineMs: 30_000,
  });
  assert.ok(uploaded.datasetId.startsWith("upload-"));
  assert.equal(uploaded.rowCount, fixtureBars.length);
  assert.equal(uploaded.deduped, false);
  assert.ok(catalogIds().includes(uploaded.datasetId));
  assert.equal(tempDirs().length, 0, "temp must be cleared after register");

  const sub = await client.submit({
    idempotencyKey: `up-run-${Date.now()}`,
    datasetId: uploaded.datasetId,
    candidate: {
      candidateId: "ma-5-20",
      fastMa: 5,
      slowMa: 20,
      buyPct: 0.1,
      stopLossPct: 0.05,
      dataVersion: uploaded.dataVersion,
    },
  });
  const job = await client.waitForTerminal(sub.jobId, { timeoutMs: 45_000 });
  assert.equal(job.status, "SUCCEEDED", job.error);
  assert.equal(job.candidate.dataVersion, uploaded.dataVersion);

  // Consume Kafka completion and confirm same version via GetBacktestJob
  for (let i = 0; i < 40; i++) {
    const outbox = path.join(STORE, "outbox");
    if (existsSync(outbox)) {
      const published = readdirSync(outbox)
        .filter((f) => f.includes(sub.jobId) && f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { published_at_unix_ms: number | null });
      if (published.some((p) => p.published_at_unix_ms)) break;
    }
    await sleep(100);
  }
  const obsRoot = path.join(EXT_ROOT, ".bus", "observations-test", `upload-${process.pid}`);
  rmSync(obsRoot, { recursive: true, force: true });
  const obs = new ObservationStore(obsRoot);
  const ac = new AbortController();
  const consumer = new BacktestResultConsumer(BROKERS.split(","), BIND, obs, {
    groupId: `${RESULT_CONSUMER_GROUP}-up-${Date.now()}`,
  });
  const timer = setTimeout(() => ac.abort(), 12_000);
  await consumer.run({
    signal: ac.signal,
    abort: () => ac.abort(),
    fromBeginning: true,
    onEvent: (e) => {
      if (e.jobId === sub.jobId) setTimeout(() => ac.abort(), 30);
    },
  });
  clearTimeout(timer);
  const seen = obs.list().filter((o) => o.jobId === sub.jobId);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.jobStatus, "SUCCEEDED");
  console.log(
    JSON.stringify({
      uploadThenBacktest: true,
      datasetId: uploaded.datasetId,
      dataVersion: uploaded.dataVersion,
      jobId: sub.jobId,
      fixtureBars: fixtureBars.length,
    }),
  );
});

test("upload: identical re-upload returns same dataset (deduped)", async () => {
  const a = await client.uploadBars({
    bars: fixtureBars,
    ticker: "005930",
    interval: "1d",
    batchSize: 10,
  });
  const b = await client.uploadBars({
    bars: fixtureBars,
    ticker: "005930",
    interval: "1d",
    batchSize: 5,
  });
  assert.equal(a.datasetId, b.datasetId);
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(b.deduped, true);
  const active = catalogIds().filter((id) => id === a.datasetId);
  assert.equal(active.length, 1);
});

test("upload: duplicate timestamp rejected and not cataloged", async () => {
  const bad = [...fixtureBars.slice(0, 5)];
  bad.push({ ...bad[2]!, tMs: bad[2]!.tMs }); // duplicate
  const before = new Set(catalogIds());
  let code: number | undefined;
  try {
    await client.uploadBars({ bars: bad, ticker: "005930", interval: "1d", batchSize: 3 });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.equal(code, grpc.status.INVALID_ARGUMENT);
  assert.deepEqual(catalogIds().filter((id) => !before.has(id)), []);
  assert.equal(tempDirs().length, 0);
});

test("upload: out-of-order bars rejected", async () => {
  const bad = [fixtureBars[2]!, fixtureBars[1]!, fixtureBars[0]!];
  let code: number | undefined;
  try {
    await client.uploadBars({ bars: bad, ticker: "005930", interval: "1d", batchSize: 2 });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.equal(code, grpc.status.INVALID_ARGUMENT);
  assert.equal(tempDirs().length, 0);
});

test("upload: invalid OHLC rejected", async () => {
  const bad = fixtureBars.slice(0, 3).map((b, i) =>
    i === 1 ? { ...b, high: b.low - 1 } : b,
  );
  let code: number | undefined;
  try {
    await client.uploadBars({ bars: bad, ticker: "005930", interval: "1d", batchSize: 2 });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.equal(code, grpc.status.INVALID_ARGUMENT);
});

test("upload: bars-per-chunk limit exceeded", async () => {
  // Server default MAX_BARS_PER_CHUNK=500 — send one huge chunk via tiny limit env restart
  await stopProc(server);
  server = startServer({
    store: STORE,
    bind: BIND,
    env: { EXT_UPLOAD_MAX_BARS_PER_CHUNK: "3" },
  });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000 });

  let code: number | undefined;
  try {
    await client.uploadBars({
      bars: fixtureBars.slice(0, 10),
      ticker: "005930",
      interval: "1d",
      batchSize: 10, // one chunk of 10 > 3
    });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.ok(code === grpc.status.INVALID_ARGUMENT || code === grpc.status.RESOURCE_EXHAUSTED);

  // restore defaults
  await stopProc(server);
  server = startServer({ store: STORE, bind: BIND });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000, uploadSendBuffer: 2 });
});

test("upload: client cancel mid-stream leaves no catalog entry / no temps", async () => {
  const before = new Set(catalogIds());
  let code: number | undefined;
  try {
    await client.uploadBars({
      bars: fixtureBars,
      ticker: "005930",
      interval: "1d",
      batchSize: 5,
      cancelAfterChunks: 2,
      sendBuffer: 1,
    });
  } catch (err) {
    code = isServiceError(err) ? err.code : grpc.status.CANCELLED;
  }
  assert.ok(code === grpc.status.CANCELLED || code === grpc.status.INVALID_ARGUMENT || code != null);
  await sleep(200);
  assert.deepEqual(catalogIds().filter((id) => !before.has(id)), []);
  assert.equal(tempDirs().length, 0);
  console.log(JSON.stringify({ cancelMidStream: true, code, temps: tempDirs().length }));
});

test("upload: recv delay + short client deadline → no catalog leak", async () => {
  await stopProc(server);
  server = startServer({ store: STORE, bind: BIND, uploadRecvDelayMs: 400 });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000 });

  const before = new Set(catalogIds());
  let code: number | undefined;
  try {
    await client.uploadBars({
      bars: fixtureBars.slice(0, 15),
      ticker: "005930",
      interval: "1d",
      batchSize: 3,
      clientDeadlineUnixMs: Date.now() + 300,
      rpcDeadlineMs: 5_000,
      sendBuffer: 1,
    });
  } catch (err) {
    assert.ok(isServiceError(err));
    code = err.code;
  }
  assert.ok(
    code === grpc.status.DEADLINE_EXCEEDED ||
      code === grpc.status.INVALID_ARGUMENT ||
      code === grpc.status.CANCELLED,
  );
  await sleep(200);
  assert.deepEqual(catalogIds().filter((id) => !before.has(id)), []);
  assert.equal(tempDirs().length, 0);

  await stopProc(server);
  server = startServer({ store: STORE, bind: BIND });
  await waitPort(host, port, 15_000);
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000, uploadSendBuffer: 2 });
});

test("upload: crash before register — restart purges temp; reupload single active dataset", async () => {
  await stopProc(server);
  // Seed a fake incomplete temp; startup configure_catalog force-purges orphans.
  const orphan = path.join(STORE, "datasets", "tmp", "orphan-session");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(
    path.join(orphan, "session.json"),
    JSON.stringify({ created_at_unix_ms: Date.now() - 10_000, closed: false }),
  );
  writeFileSync(path.join(orphan, "bars.jsonl"), "{}\n");

  server = startServer({
    store: STORE,
    bind: BIND,
    env: { EXT_UPLOAD_CRASH_BEFORE_REGISTER: "1" },
  });
  await waitPort(host, port, 15_000);
  // Orphan from before configure must already be gone.
  assert.ok(!tempDirs().includes("orphan-session"));
  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000 });

  const before = new Set(catalogIds());
  try {
    await client.uploadBars({
      bars: fixtureBars.slice(0, 12),
      ticker: "005930",
      interval: "1d",
      batchSize: 4,
    });
  } catch {
    /* expected — server crashed before catalog register */
  }
  for (let i = 0; i < 50; i++) {
    if (server.proc.exitCode != null) break;
    await sleep(100);
  }
  assert.ok(server.proc.exitCode != null, "server must have exited from crash hook");
  // Crash left temp on disk; catalog must still be clean.
  assert.deepEqual(catalogIds().filter((id) => !before.has(id)), []);
  assert.ok(tempDirs().length >= 1, "hard crash leaves orphan temp until restart");

  await stopProc(server);
  server = startServer({ store: STORE, bind: BIND });
  await waitPort(host, port, 15_000);
  assert.equal(tempDirs().length, 0, "restart must force-purge orphan temps");
  assert.deepEqual(catalogIds().filter((id) => !before.has(id)), []);

  client.close();
  client = new TradingAnalysisClient(BIND, { deadlineMs: 10_000 });
  const uploaded = await client.uploadBars({
    bars: fixtureBars.slice(0, 12),
    ticker: "005930",
    interval: "1d",
    batchSize: 4,
  });
  const again = await client.uploadBars({
    bars: fixtureBars.slice(0, 12),
    ticker: "005930",
    interval: "1d",
    batchSize: 4,
  });
  assert.equal(uploaded.datasetId, again.datasetId);
  assert.equal(again.deduped, true);
  assert.equal(catalogIds().filter((id) => id === uploaded.datasetId).length, 1);
  console.log(JSON.stringify({ crashBeforeRegisterRecovered: true, datasetId: uploaded.datasetId }));
});
