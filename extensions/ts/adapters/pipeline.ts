/**
 * Fixture → Kafka producer → consumer → Redis pipeline.
 * Offset commit happens only after Redis applyTrade succeeds.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { QuoteIngestProducer } from "../ingest/producer.ts";
import {
  assertRealInfraOrThrow,
  loadRealInfraConfig,
  TICKER_QUOTES_TOPIC,
  type RealInfraConfig,
} from "../shared/config.ts";
import { KafkaMarketBus, pingKafka } from "./kafka-bus.ts";
import { RedisQuoteStore } from "./redis-store.ts";
import type { TradeEvent } from "../shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "../..");

export type PipelineStats = {
  adapter: { kafka: "kafka"; redis: "redis" };
  brokers: string[];
  redisUrl: string;
  published: number;
  consumed: number;
  duplicates: number;
  droppedTrades: number;
  incompleteMarked: number;
  publishErrors: number;
  orderbookPaperUnverified: true;
};

export async function requireRealInfra(cfg = loadRealInfraConfig()): Promise<RealInfraConfig> {
  assertRealInfraOrThrow(cfg);
  const k = await pingKafka(cfg.kafkaBrokers);
  if (!k.ok) {
    throw new Error(`Kafka connect failed: ${k.detail}`);
  }
  const store = RedisQuoteStore.connect(cfg.redisUrl);
  const r = await store.ping();
  await store.close();
  if (!r.ok) {
    throw new Error(`Redis connect failed: ${r.detail}`);
  }
  console.log(
    JSON.stringify({
      realAdapters: true,
      kafka: k.detail,
      redis: r.detail,
      topic: TICKER_QUOTES_TOPIC,
    }),
  );
  return cfg;
}

export function loadFixtureFrames(fixturePath?: string): string[] {
  const file = fixturePath ?? path.join(EXT_ROOT, "fixtures/h0stcnt0-frames.jsonl");
  if (existsSync(file)) {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const parsed = JSON.parse(l) as { frame?: string } | string;
        return typeof parsed === "string" ? parsed : String(parsed.frame ?? "");
      })
      .filter(Boolean);
  }
  return [
    buildH0stCnt0Fixture({
      MKSC_SHRN_ISCD: "005930",
      STCK_PRPR: "70000",
      CNTG_VOL: "10",
      BSOP_DATE: "20261110",
      STCK_CNTG_HOUR: "103015",
    }),
    buildH0stCnt0Fixture({
      MKSC_SHRN_ISCD: "005930",
      STCK_PRPR: "70100",
      CNTG_VOL: "5",
      BSOP_DATE: "20261110",
      STCK_CNTG_HOUR: "103016",
    }),
  ];
}

export async function publishFixturesToKafka(opts: {
  cfg: RealInfraConfig;
  frames?: string[];
  queueCapacity?: number;
}): Promise<{ bus: KafkaMarketBus; producer: QuoteIngestProducer; published: number }> {
  const bus = new KafkaMarketBus(opts.cfg);
  await bus.connectProducer();
  const producer = new QuoteIngestProducer(bus, {
    queueCapacity: opts.queueCapacity ?? opts.cfg.queueCapacity,
    batchSize: opts.cfg.batchSize,
    batchWaitMs: opts.cfg.batchWaitMs,
    maxRetries: opts.cfg.publishRetries,
    emitOrderBookStub: false, // PAPER ASP0 unverified — TRADE only
  });
  const ac = new AbortController();
  const loop = producer.startPublishLoop(ac.signal);
  for (const frame of opts.frames ?? loadFixtureFrames()) {
    producer.onRawFrame(frame);
  }
  // Drain
  for (let i = 0; i < 40; i++) {
    if (producer.metrics.enqueued <= producer.metrics.published + producer.metrics.publishErrors) {
      break;
    }
    await sleep(50);
  }
  await sleep(100);
  ac.abort();
  producer.stop();
  await loop;
  return { bus, producer, published: producer.metrics.published };
}

export async function consumeKafkaToRedis(opts: {
  cfg: RealInfraConfig;
  groupId: string;
  maxMessages: number;
  fromBeginning?: boolean;
  crashBeforeCommitAfter?: number;
  idleMs?: number;
}): Promise<{
  store: RedisQuoteStore;
  bus: KafkaMarketBus;
  stats: PipelineStats;
}> {
  const store = RedisQuoteStore.connect(opts.cfg.redisUrl);
  const bus = new KafkaMarketBus(opts.cfg);
  let consumed = 0;
  let duplicates = 0;
  let incompleteMarked = 0;
  const ac = new AbortController();
  const idle = opts.idleMs ?? 3_000;

  const run = bus.runConsumer({
    groupId: opts.groupId,
    fromBeginning: opts.fromBeginning ?? true,
    signal: ac.signal,
    crashBeforeCommit: false,
    handler: async ({ event }) => {
      if (event.kind !== "TRADE") return;
      const trade = event as TradeEvent;
      try {
        const result = await store.applyTrade(trade);
        if (result.duplicate) duplicates += 1;
        else consumed += 1;
      } catch (err) {
        // Redis failure — do not commit (handler throw prevents commit)
        throw err;
      }
      if (
        opts.crashBeforeCommitAfter != null &&
        consumed + duplicates >= opts.crashBeforeCommitAfter
      ) {
        // Simulate process death after Redis success, before offset commit.
        throw new Error("CRASH_BEFORE_OFFSET_COMMIT");
      }
      if (consumed + duplicates >= opts.maxMessages) {
        setTimeout(() => ac.abort(), 10);
      }
    },
  });

  const watchdog = setTimeout(() => ac.abort(), idle + 5_000);
  try {
    await Promise.race([
      run,
      sleep(idle).then(() => ac.abort()),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("CRASH_BEFORE_OFFSET_COMMIT")) throw err;
  } finally {
    clearTimeout(watchdog);
    ac.abort();
    await sleep(50);
  }

  return {
    store,
    bus,
    stats: {
      adapter: { kafka: "kafka", redis: "redis" },
      brokers: opts.cfg.kafkaBrokers,
      redisUrl: opts.cfg.redisUrl,
      published: 0,
      consumed,
      duplicates,
      droppedTrades: 0,
      incompleteMarked,
      publishErrors: 0,
      orderbookPaperUnverified: true,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
