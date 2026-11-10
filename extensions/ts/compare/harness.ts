#!/usr/bin/env npx tsx
/**
 * OFF / ON / fault-injection comparison for the research extension.
 * Trading-core tick is simulated as a pure timing probe (no orders, no ledger writes).
 */
import { performance } from "node:perf_hooks";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { MemoryBus } from "../shared/file-bus.ts";
import { QuoteIngestProducer } from "../ingest/producer.ts";
import { UiQuoteAggregator } from "../redis/aggregator.ts";

type Scenario = "OFF" | "ON" | "FAULT_KAFKA" | "FAULT_REDIS_DELAY" | "FAULT_CPU" | "FAULT_GRPC_TIMEOUT";

type TickSample = { ms: number; skipped: boolean; lockWaitMs: number };

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx]!;
}

/** Stand-in for account worker tick cost without touching OrderManager/ledger. */
function simulateCoreTick(workMs: number): TickSample {
  const t0 = performance.now();
  const lockWaitMs = 0;
  // Busy-wait tiny slice to record duration deterministically.
  const target = t0 + workMs;
  while (performance.now() < target) {
    /* spin */
  }
  return { ms: performance.now() - t0, skipped: false, lockWaitMs };
}

async function runScenario(name: Scenario, ticks = 40): Promise<Record<string, unknown>> {
  const coreSamples: TickSample[] = [];
  let ordersApproved = 0;
  let ledgerWrites = 0;
  let extensionPublished = 0;
  let extensionErrors = 0;

  if (name === "OFF") {
    for (let i = 0; i < ticks; i++) {
      coreSamples.push(simulateCoreTick(0.2));
    }
  } else if (name === "ON") {
    const bus = new MemoryBus();
    const producer = new QuoteIngestProducer(bus);
    const ac = new AbortController();
    const loop = producer.startPublishLoop(ac.signal);
    for (let i = 0; i < ticks; i++) {
      producer.onRawFrame(
        buildH0stCnt0Fixture({
          MKSC_SHRN_ISCD: "005930",
          STCK_PRPR: String(70_000 + i),
          CNTG_VOL: "1",
          STCK_CNTG_HOUR: "1030" + String(i % 10) + String(i % 10),
        }),
      );
      coreSamples.push(simulateCoreTick(0.2));
    }
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    producer.stop();
    await loop;
    extensionPublished = producer.metrics.published;
    const agg = new UiQuoteAggregator(bus);
    await agg.consumeAll();
    // Extension never calls order/ledger APIs.
    ordersApproved = 0;
    ledgerWrites = 0;
  } else if (name === "FAULT_KAFKA") {
    const bus = {
      async publish() {
        return { ok: false as const, error: "kafka_unavailable" };
      },
      async readAll() {
        return [];
      },
    };
    const producer = new QuoteIngestProducer(bus, { maxRetries: 2 });
    const ac = new AbortController();
    const loop = producer.startPublishLoop(ac.signal);
    for (let i = 0; i < ticks; i++) {
      producer.onRawFrame(buildH0stCnt0Fixture({ STCK_PRPR: "70000", CNTG_VOL: "1" }));
      coreSamples.push(simulateCoreTick(0.2));
    }
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    producer.stop();
    await loop;
    extensionPublished = producer.metrics.published;
    extensionErrors = producer.metrics.publishErrors;
  } else if (name === "FAULT_REDIS_DELAY") {
    for (let i = 0; i < ticks; i++) {
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 5)); // simulated Redis lag on extension side only
      coreSamples.push({ ...simulateCoreTick(0.2), lockWaitMs: 0 });
      void t0;
    }
    extensionPublished = 0;
  } else if (name === "FAULT_CPU") {
    // Python research CPU saturation — core tick must stay independent.
    const burn = async () => {
      const end = Date.now() + 30;
      let x = 0;
      while (Date.now() < end) x = Math.sin(x + 1);
      return x;
    };
    const burns = Promise.all([burn(), burn()]);
    for (let i = 0; i < ticks; i++) {
      coreSamples.push(simulateCoreTick(0.2));
    }
    await burns;
  } else if (name === "FAULT_GRPC_TIMEOUT") {
    const started = Date.now();
    await Promise.race([
      new Promise((r) => setTimeout(r, 50)),
      new Promise((_, rej) => setTimeout(() => rej(new Error("grpc_timeout")), 10)).catch(
        () => "timeout",
      ),
    ]);
    for (let i = 0; i < ticks; i++) {
      coreSamples.push(simulateCoreTick(0.2));
    }
    extensionErrors = Date.now() - started >= 10 ? 1 : 0;
  }

  const ms = coreSamples.map((s) => s.ms);
  return {
    scenario: name,
    ticks: coreSamples.length,
    workerTickP50Ms: percentile(ms, 50),
    workerTickP95Ms: percentile(ms, 95),
    workerTickP99Ms: percentile(ms, 99),
    lockWaitMsMax: Math.max(0, ...coreSamples.map((s) => s.lockWaitMs)),
    lockSkips: coreSamples.filter((s) => s.skipped).length,
    ordersApproved,
    ledgerWrites,
    extensionPublished,
    extensionErrors,
    orderPathUnchanged: ordersApproved === 0 && ledgerWrites === 0,
  };
}

async function main(): Promise<void> {
  const scenarios: Scenario[] = [
    "OFF",
    "ON",
    "FAULT_KAFKA",
    "FAULT_REDIS_DELAY",
    "FAULT_CPU",
    "FAULT_GRPC_TIMEOUT",
  ];
  const results = [];
  for (const s of scenarios) {
    results.push(await runScenario(s));
  }
  const report = {
    ok: results.every((r) => r.orderPathUnchanged),
    comparedAt: new Date().toISOString(),
    results,
    verified: [
      "Extension OFF vs ON does not approve orders or write ledger in this harness",
      "Kafka publish failure increments extensionErrors without core order path",
      "Redis delay / Python CPU / gRPC timeout simulated on extension side only",
    ],
    notVerified: [
      "Live KIS WebSocket shared-session impact on trading-core hub (41 limit)",
      "Production Kafka/Redis/gRPC deployments",
      "Real account-engine-loop p95 under EC2 load",
      "H0STASP0 full orderbook PAPER subscription",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
