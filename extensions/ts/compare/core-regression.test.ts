/**
 * Trading-core regression with extensions OFF / ON / fault.
 *
 * Worker path: uses existing FakeBroker + OrderManager (real order path code),
 * NOT the compare/harness.ts timing simulation alone.
 *
 * Extensions ON/fault run alongside but must not change order/ledger outcomes
 * for the same core inputs.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { SEOUL_REGULAR_SESSION_MS } from "@/lib/market-hours";
import { setNowMs } from "@/src/clock";
import { FakeBroker, makeTestPaperState } from "@/src/test-support";
import { tryAcquireWorkerLock, releaseWorkerLock, resetWorkerLockForTest } from "@/src/runtime/worker-lock";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryBus } from "../shared/file-bus.ts";
import { QuoteIngestProducer } from "../ingest/producer.ts";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { loadRealInfraConfig } from "../shared/config.ts";

type Scenario = "OFF" | "ON" | "FAULT_EXT_PUBLISH";

type Outcome = {
  scenario: Scenario;
  path: "worker-FakeBroker";
  ticks: number;
  tickSamplesMs: number[];
  p95Ms: number;
  p99Ms: number;
  lockSkips: number;
  orders: number;
  ledgerWrites: number;
  blockedOrders: number;
};

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]!;
}

async function runCoreOrderCase(input: {
  scenario: Scenario;
  allowOrder: boolean;
}): Promise<Outcome> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ext-core-reg-"));
  const lockPath = path.join(dir, "worker.lock");
  resetWorkerLockForTest();
  assert.equal(tryAcquireWorkerLock(`ext-reg-${input.scenario}`, { filePath: lockPath }), true);

  const tickSamplesMs: number[] = [];
  let orders = 0;
  let ledgerWrites = 0;
  let blockedOrders = 0;
  let lockSkips = 0;

  // Optional extension noise (file bus — not required for core path).
  let ext: QuoteIngestProducer | null = null;
  let extLoop: Promise<void> | null = null;
  let extAc: AbortController | null = null;
  if (input.scenario === "ON" || input.scenario === "FAULT_EXT_PUBLISH") {
    const bus =
      input.scenario === "FAULT_EXT_PUBLISH"
        ? {
            async publish() {
              return { ok: false as const, error: "kafka_unavailable" };
            },
            async readAll() {
              return [];
            },
          }
        : new MemoryBus();
    ext = new QuoteIngestProducer(bus, { maxRetries: 1 });
    extAc = new AbortController();
    extLoop = ext.startPublishLoop(extAc.signal);
    for (let i = 0; i < 5; i++) {
      ext.onRawFrame(buildH0stCnt0Fixture({ STCK_PRPR: String(70_000 + i), CNTG_VOL: "1" }));
    }
  }

  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    // Simulate one worker tick slice: lock already held; evaluate one broker action.
    const box = { current: makeTestPaperState() };
    box.current.settings.autoTrading = input.allowOrder;
    box.current.settings.disclaimerAccepted = true;
    box.current.settings.ignoreMarketHours = true;
    const broker = new FakeBroker(box, "cash");
    const beforeOrders = box.current.orders.length;
    const beforeFilled = box.current.orders.filter((o) => o.status === "filled").length;

    if (!input.allowOrder) {
      // Existing OrderManager block: disclaimer gate (executionLocked)
      box.current.settings.disclaimerAccepted = false;
    }
    const fill = await broker.buyMarket("005930", 150_000);
    const afterOrders = box.current.orders.length;
    const afterFilled = box.current.orders.filter((o) => o.status === "filled").length;

    if (fill.ok) {
      orders += 1;
      // FakeBroker mutates in-memory book — count as ledger-equivalent change for isolation.
      ledgerWrites += Math.max(0, afterFilled - beforeFilled) || (afterOrders > beforeOrders ? 1 : 0);
    } else {
      blockedOrders += 1;
    }
    tickSamplesMs.push(performance.now() - t0);
  }

  if (ext && extAc && extLoop) {
    extAc.abort();
    ext.stop();
    await extLoop;
  }

  releaseWorkerLock(`ext-reg-${input.scenario}`, { filePath: lockPath });
  resetWorkerLockForTest();
  rmSync(dir, { recursive: true, force: true });

  return {
    scenario: input.scenario,
    path: "worker-FakeBroker",
    ticks,
    tickSamplesMs,
    p95Ms: pct(tickSamplesMs, 95),
    p99Ms: pct(tickSamplesMs, 99),
    lockSkips,
    orders,
    ledgerWrites,
    blockedOrders,
  };
}

before(() => setNowMs(SEOUL_REGULAR_SESSION_MS));
after(() => setNowMs(null));

test("core regression: regular session allow-order expects 1 order path per tick when ON/OFF/fault ext", async () => {
  const real = loadRealInfraConfig();
  console.log(
    JSON.stringify({
      note: "Worker path = FakeBroker OrderManager (not harness simulation)",
      extensionsRealInfra: real.enabled,
      harnessVsWorker: "this file = worker-FakeBroker; compare/harness.ts = timing simulation only",
      scopeNote: "local FakeBroker — not production DB or EC2 performance",
    }),
  );

  const scenarios: Scenario[] = ["OFF", "ON", "FAULT_EXT_PUBLISH"];
  const allowResults: Outcome[] = [];
  for (const scenario of scenarios) {
    const outcome = await runCoreOrderCase({ scenario, allowOrder: true });
    assert.equal(outcome.orders, 5, `${scenario}: expected 5 successful test orders`);
    assert.equal(outcome.ledgerWrites, 5, `${scenario}: expected 5 ledger-equivalent fills`);
    assert.equal(outcome.blockedOrders, 0);
    allowResults.push(outcome);
  }
  console.log(
    JSON.stringify(
      {
        allowMatrix: allowResults.map((r) => ({
          scenario: r.scenario,
          path: r.path,
          ticks: r.ticks,
          sampleCount: r.tickSamplesMs.length,
          p95Ms: r.p95Ms,
          p99Ms: r.p99Ms,
          lockSkips: r.lockSkips,
          orders: r.orders,
          ledgerWrites: r.ledgerWrites,
        })),
      },
      null,
      2,
    ),
  );
  assert.ok(allowResults.every((r) => r.orders === 5 && r.ledgerWrites === 5));
});

test("core regression: existing block (disclaimer) → 0 orders / 0 ledger across OFF/ON/fault", async () => {
  const scenarios: Scenario[] = ["OFF", "ON", "FAULT_EXT_PUBLISH"];
  const results: Outcome[] = [];
  for (const scenario of scenarios) {
    results.push(await runCoreOrderCase({ scenario, allowOrder: false }));
  }
  console.log(JSON.stringify({ blockedMatrix: results }, null, 2));
  for (const r of results) {
    assert.equal(r.orders, 0, `${r.scenario}: orders must be 0`);
    assert.equal(r.ledgerWrites, 0, `${r.scenario}: ledger writes must be 0`);
    assert.ok(r.blockedOrders >= 1);
  }
});
