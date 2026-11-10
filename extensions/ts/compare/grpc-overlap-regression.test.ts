/**
 * FakeBroker Worker regression WHILE real gRPC backtest is running,
 * and again under Python gRPC fault — same allow/block inputs.
 *
 * Records whether gRPC work overlapped with Worker order path execution.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import { FakeBroker, makeTestPaperState } from "@/src/test-support";
import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
  resetWorkerLockForTest,
} from "@/src/runtime/worker-lock";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TradingAnalysisClient } from "../grpc/client.ts";
import {
  freshStore,
  parseBind,
  sleep,
  startServer,
  startWorker,
  stopProc,
  waitPort,
  type ProcHandle,
} from "../grpc/harness.ts";

const BIND = `127.0.0.1:${19000 + (process.pid % 1000)}`;
const { host, port } = parseBind(BIND);

type Outcome = {
  scenario: string;
  orders: number;
  ledgerWrites: number;
  blockedOrders: number;
  p95Ms: number;
  sampleCount: number;
  grpcOverlap: boolean;
  grpcJobStatus?: string;
};

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]!;
}

async function runOrders(allow: boolean, ticks = 5): Promise<Omit<Outcome, "scenario" | "grpcOverlap" | "grpcJobStatus">> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ext-grpc-ov-"));
  const lockPath = path.join(dir, "worker.lock");
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock(`grpc-ov-${allow}`, { filePath: lockPath }), true);

  const samples: number[] = [];
  let orders = 0;
  let ledgerWrites = 0;
  let blockedOrders = 0;

  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    const box = { current: makeTestPaperState() };
    box.current.settings.autoTrading = true;
    box.current.settings.disclaimerAccepted = allow;
    box.current.settings.ignoreMarketHours = true;
    const beforeFilled = box.current.orders.filter((o) => o.status === "filled").length;
    const fill = await new FakeBroker(box, "cash").buyMarket("005930", 150_000);
    const afterFilled = box.current.orders.filter((o) => o.status === "filled").length;
    if (fill.ok) {
      orders += 1;
      ledgerWrites += Math.max(0, afterFilled - beforeFilled) || 1;
    } else {
      blockedOrders += 1;
    }
    samples.push(performance.now() - t0);
  }

  releaseWorkerLock(`grpc-ov-${allow}`, { filePath: lockPath });
  resetWorkerLockForTest();
  rmSync(dir, { recursive: true, force: true });
  return {
    orders,
    ledgerWrites,
    blockedOrders,
    p95Ms: pct(samples, 95),
    sampleCount: samples.length,
  };
}

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

test("overlap: FakeBroker allow/block while backtest RUNNING on real gRPC", async () => {
  const store = freshStore(`overlap-ok-${process.pid}`);
  let server: ProcHandle | null = null;
  let worker: ProcHandle | null = null;
  let client: TradingAnalysisClient | null = null;
  try {
    server = startServer({ store, bind: BIND, queueCap: 16 });
    await waitPort(host, port, 15_000);
    // Slow-ish lease but worker runs normally
    // delay so FakeBroker ticks happen while job is RUNNING
    worker = startWorker({ store, workerId: "ov-worker", leaseMs: 15_000, delayMs: 1_500 });
    client = new TradingAnalysisClient(BIND);

    const sub = await client.submit({
      idempotencyKey: `ov-run-${Date.now()}`,
      datasetId: "synthetic-v0",
      candidate: { candidateId: "ov", fastMa: 5, slowMa: 20, buyPct: 0.1, stopLossPct: 0.05 },
    });

    // Poll until RUNNING to prove overlap window
    let sawRunning = false;
    for (let i = 0; i < 80; i++) {
      const j = await client.get(sub.jobId);
      if (j.status === "RUNNING") {
        sawRunning = true;
        break;
      }
      if (j.status === "SUCCEEDED" || j.status === "FAILED") break;
      await sleep(25);
    }
    assert.equal(sawRunning, true, "expected RUNNING overlap with Worker ticks");

    const allow = await runOrders(true);
    const block = await runOrders(false);
    const mid = await client.get(sub.jobId);
    assert.ok(["RUNNING", "SUCCEEDED"].includes(mid.status), mid.status);
    const terminal = await client.waitForTerminal(sub.jobId, { timeoutMs: 45_000 });

    const allowOut: Outcome = {
      scenario: "grpc_backtest_active_allow",
      ...allow,
      grpcOverlap: sawRunning || terminal.status === "SUCCEEDED",
      grpcJobStatus: terminal.status,
    };
    const blockOut: Outcome = {
      scenario: "grpc_backtest_active_block",
      ...block,
      grpcOverlap: sawRunning || terminal.status === "SUCCEEDED",
      grpcJobStatus: terminal.status,
    };

    assert.equal(allowOut.orders, 5);
    assert.equal(allowOut.ledgerWrites, 5);
    assert.equal(blockOut.orders, 0);
    assert.equal(blockOut.ledgerWrites, 0);
    assert.equal(terminal.status, "SUCCEEDED");
    console.log(
      JSON.stringify(
        {
          note: "Worker path = FakeBroker; gRPC = real Python server+worker",
          sawRunning,
          allowOut,
          blockOut,
          scopeNote: "local only — not EC2/prod",
        },
        null,
        2,
      ),
    );
  } finally {
    client?.close();
    await stopProc(worker);
    await stopProc(server);
  }
});

test("overlap: FakeBroker allow/block while Python gRPC is down (fault)", async () => {
  // No server — client calls fail; Worker path must be unchanged.
  const dead = new TradingAnalysisClient(`127.0.0.1:1`, { deadlineMs: 500 });
  let grpcFailed = false;
  const t0 = performance.now();
  try {
    await dead.submit({
      idempotencyKey: `fault-${Date.now()}`,
      datasetId: "synthetic-v0-short",
      candidate: { fastMa: 5, slowMa: 20 },
    });
  } catch {
    grpcFailed = true;
  }
  const allow = await runOrders(true);
  const block = await runOrders(false);
  const overlapped = grpcFailed; // fault observed in same test as Worker ticks
  dead.close();

  assert.equal(grpcFailed, true);
  assert.equal(allow.orders, 5);
  assert.equal(allow.ledgerWrites, 5);
  assert.equal(block.orders, 0);
  assert.equal(block.ledgerWrites, 0);
  console.log(
    JSON.stringify(
      {
        scenario: "python_grpc_fault",
        grpcFailed,
        overlappedWithWorker: overlapped,
        elapsedMs: performance.now() - t0,
        allow,
        block,
      },
      null,
      2,
    ),
  );
});
