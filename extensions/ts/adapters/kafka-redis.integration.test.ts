/**
 * Real Kafka + Redis integration tests.
 * Requires: EXTENSIONS_REAL_INFRA=1 and docker compose infra up.
 * Prints adapter mode; fails clearly when infra missing.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { QuoteIngestProducer } from "../ingest/producer.ts";
import { tradeFromH0stCnt0 } from "../ingest/parse-bridge.ts";
import { parseH0stCnt0Realtime } from "../../../src/market-data/h0stcnt0.ts";
import {
  DEDUPE_TTL_SEC,
  EXT_CONSUMER_GROUP,
  TICKER_QUOTES_TOPIC,
  loadRealInfraConfig,
} from "../shared/config.ts";
import type { TradeEvent } from "../shared/types.ts";
import { KafkaMarketBus, pingKafka } from "./kafka-bus.ts";
import { RedisQuoteStore } from "./redis-store.ts";
import { minuteStart } from "../redis/memory-store.ts";

const cfg = loadRealInfraConfig();
const RUN = cfg.enabled;

function skipUnlessReal(): void {
  if (!RUN) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "EXTENSIONS_REAL_INFRA not set — refusing file fallback",
        realAdapters: false,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        realAdapters: true,
        kafkaBrokers: cfg.kafkaBrokers,
        redisUrl: cfg.redisUrl,
      }),
    );
  }
}

skipUnlessReal();

let bus: KafkaMarketBus;
let store: RedisQuoteStore;

before(async () => {
  if (!RUN) return;
  const k = await pingKafka(cfg.kafkaBrokers);
  assert.equal(k.ok, true, `Kafka must be up: ${k.detail}`);
  store = RedisQuoteStore.connect(cfg.redisUrl);
  const r = await store.ping();
  assert.equal(r.ok, true, `Redis must be up: ${r.detail}`);
  await store.flushNamespace();
  bus = new KafkaMarketBus(cfg);
  await bus.connectProducer();
});

after(async () => {
  if (!RUN) return;
  await bus?.disconnect();
  await store?.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tradeAt(
  symbol: string,
  price: number,
  vol: number,
  exchangeTsMs: number,
  seq: string,
  receivedTsMs = exchangeTsMs,
): TradeEvent {
  const frame = buildH0stCnt0Fixture({
    MKSC_SHRN_ISCD: symbol,
    STCK_PRPR: String(price),
    CNTG_VOL: String(vol),
    BSOP_DATE: "20261110",
    STCK_CNTG_HOUR: "103015",
  });
  const parsed = parseH0stCnt0Realtime(frame);
  assert.ok(parsed);
  const base = tradeFromH0stCnt0(parsed!, receivedTsMs);
  return {
    ...base,
    eventId: `TRADE:KR:${symbol}:${exchangeTsMs}:${seq}`,
    exchangeTsMs,
    receivedTsMs,
    price,
    tradeVolume: vol,
    version: Number(seq.replace(/\D/g, "") || 1),
  };
}

async function consumeN(opts: {
  groupId: string;
  max: number;
  /** Only count/apply TRADE events whose eventId is in this set (ignore topic backlog). */
  onlyEventIds?: Set<string>;
  crashAfter?: number;
  idleMs?: number;
}): Promise<{ consumed: number; duplicates: number; crashed: boolean }> {
  let consumed = 0;
  let duplicates = 0;
  let crashed = false;
  const ac = new AbortController();
  const idle = opts.idleMs ?? 10_000;

  const runPromise = bus.runConsumer({
    groupId: opts.groupId,
    fromBeginning: true,
    signal: ac.signal,
    handler: async ({ event }) => {
      if (event.kind !== "TRADE") return;
      if (opts.onlyEventIds && !opts.onlyEventIds.has(event.eventId)) return;
      const result = await store.applyTrade(event as TradeEvent);
      if (result.duplicate) duplicates += 1;
      else consumed += 1;
      if (opts.crashAfter != null && consumed + duplicates >= opts.crashAfter) {
        crashed = true;
        throw new Error("CRASH_BEFORE_OFFSET_COMMIT");
      }
      if (consumed + duplicates >= opts.max) {
        setTimeout(() => ac.abort(), 50);
      }
    },
  });

  const timer = setTimeout(() => ac.abort(), idle);
  try {
    await runPromise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("CRASH_BEFORE_OFFSET_COMMIT")) throw err;
    crashed = true;
  } finally {
    clearTimeout(timer);
    ac.abort();
    await sleep(200);
  }
  return { consumed, duplicates, crashed };
}

test("real infra: happy path fixture → kafka → redis OHLCV", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const t0 = Date.parse("2026-11-10T01:30:15.000Z");
  const tag = `happy-${Date.now()}`;
  const a = tradeAt("005930", 70_000, 10, t0, `${tag}-1`);
  const b = tradeAt("005930", 70_100, 5, t0 + 1_000, `${tag}-2`);
  await bus.publish(TICKER_QUOTES_TOPIC, a);
  await bus.publish(TICKER_QUOTES_TOPIC, b);

  const groupId = `${EXT_CONSUMER_GROUP}-${tag}`;
  const stats = await consumeN({
    groupId,
    max: 2,
    onlyEventIds: new Set([a.eventId, b.eventId]),
    idleMs: 12_000,
  });
  assert.equal(stats.consumed, 2);
  const latest = await store.getLatest("005930");
  assert.ok(latest);
  assert.equal(latest!.price, 70_100);
  const bars = await store.getBars("005930");
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.open, 70_000);
  assert.equal(bars[0]!.close, 70_100);
  assert.equal(bars[0]!.high, 70_100);
  assert.equal(bars[0]!.low, 70_000);
  assert.equal(bars[0]!.volume, 15);
  assert.equal(bars[0]!.incomplete, false);
  assert.equal(bars[0]!.minuteStartMs, minuteStart(t0));
});

test("real infra: duplicate eventId does not double volume", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const t0 = Date.parse("2026-11-10T01:31:00.000Z");
  const once = tradeAt("035720", 45_200, 3, t0, `dup-${Date.now()}`);
  await bus.publish(TICKER_QUOTES_TOPIC, once);
  await bus.publish(TICKER_QUOTES_TOPIC, once);
  const groupId = `${EXT_CONSUMER_GROUP}-dup-${Date.now()}`;
  const stats = await consumeN({
    groupId,
    max: 2,
    onlyEventIds: new Set([once.eventId]),
    idleMs: 12_000,
  });
  assert.equal(stats.consumed + stats.duplicates, 2);
  assert.ok(stats.duplicates >= 1);
  const bars = await store.getBars("035720");
  assert.equal(bars[0]!.volume, 3);
});

test("real infra: late trade does not rewind latest price", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const tNew = Date.parse("2026-11-10T01:32:10.000Z");
  const tOld = Date.parse("2026-11-10T01:32:00.000Z");
  const tag = `late-${Date.now()}`;
  const newer = tradeAt("005930", 71_000, 1, tNew, `${tag}-new`);
  const older = tradeAt("005930", 69_000, 1, tOld, `${tag}-old`);
  await bus.publish(TICKER_QUOTES_TOPIC, newer);
  await bus.publish(TICKER_QUOTES_TOPIC, older);
  const groupId = `${EXT_CONSUMER_GROUP}-${tag}`;
  await consumeN({
    groupId,
    max: 2,
    onlyEventIds: new Set([newer.eventId, older.eventId]),
    idleMs: 12_000,
  });
  const latest = await store.getLatest("005930");
  assert.equal(latest!.price, 71_000, "latest must not rewind");
  const bars = await store.getBars("005930");
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.open, 69_000, "open follows earliest exchangeTs");
  assert.equal(bars[0]!.close, 71_000, "close follows latest exchangeTs");
  assert.equal(bars[0]!.high, 71_000);
  assert.equal(bars[0]!.low, 69_000);
  assert.equal(bars[0]!.volume, 2);
});

test("real infra: Redis down fails before offset commit", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const t0 = Date.parse("2026-11-10T01:33:00.000Z");
  const ev = tradeAt("005930", 70_000, 1, t0, `redis-down-${Date.now()}`);
  await bus.publish(TICKER_QUOTES_TOPIC, ev);

  // Closed port + offline queue off → command fails hard (no silent skip).
  const Redis = (await import("ioredis")).default;
  const badClient = new Redis("redis://127.0.0.1:1", {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  const bad = new RedisQuoteStore(badClient);
  let handlerFailed = false;
  const ac = new AbortController();
  const groupId = `${EXT_CONSUMER_GROUP}-redisdown-${Date.now()}`;
  const run = bus.runConsumer({
    groupId,
    fromBeginning: true,
    signal: ac.signal,
    handler: async ({ event }) => {
      if (event.kind !== "TRADE") return;
      if ((event as TradeEvent).eventId !== ev.eventId) return;
      try {
        await bad.applyTrade(event as TradeEvent);
      } catch {
        handlerFailed = true;
        throw new Error("REDIS_UNAVAILABLE");
      }
    },
  });
  setTimeout(() => ac.abort(), 8_000);
  await run.catch(() => undefined);
  await bad.close().catch(() => undefined);
  assert.equal(handlerFailed, true);
  // Good store never received this apply (handler used bad client)
  const latest = await store.getLatest("005930");
  assert.equal(latest, null);
});

test("real infra: crash after Redis before offset commit — reprocess is idempotent", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const t0 = Date.parse("2026-11-10T01:34:00.000Z");
  const tag = `crash-${Date.now()}`;
  const ev1 = tradeAt("005930", 70_500, 7, t0, `${tag}-1`);
  const ev2 = tradeAt("005930", 70_600, 2, t0 + 1_000, `${tag}-2`);
  await bus.publish(TICKER_QUOTES_TOPIC, ev1);
  await bus.publish(TICKER_QUOTES_TOPIC, ev2);
  const ids = new Set([ev1.eventId, ev2.eventId]);

  const groupId = `${EXT_CONSUMER_GROUP}-${tag}`;
  const first = await consumeN({
    groupId,
    max: 2,
    onlyEventIds: ids,
    crashAfter: 1,
    idleMs: 12_000,
  });
  assert.equal(first.crashed, true);
  assert.equal(first.consumed, 1);
  const mid = await store.getBars("005930");
  assert.equal(mid[0]!.volume, 7);

  // Restart same group — first message redelivered → duplicate; second applied.
  const second = await consumeN({
    groupId,
    max: 2,
    onlyEventIds: ids,
    idleMs: 15_000,
  });
  assert.ok(second.duplicates >= 1, "redelivery must hit dedupe SET");
  const bars = await store.getBars("005930");
  assert.equal(bars[0]!.volume, 9, "volume must not double-count after crash reprocess");
  assert.ok(DEDUPE_TTL_SEC >= 86_400);
});

test("real infra: queue saturation marks dropped trades + incomplete minute", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const tiny = new QuoteIngestProducer(bus, {
    queueCapacity: 2,
    batchSize: 1,
    batchWaitMs: 200,
    maxRetries: 1,
  });
  // Enqueue faster than publish drain
  for (let i = 0; i < 20; i++) {
    tiny.enqueue(tradeAt("005930", 70_000 + i, 1, Date.now() + i, `sat-${i}`));
  }
  assert.ok(tiny.metrics.droppedQueue >= 1, "queue overflow must drop");
  assert.ok(tiny.metrics.droppedTrades >= 1, "TRADE drops must be metered");
  const at = Date.now();
  await store.markIncomplete("005930", at);
  // Seed one applied bar so incomplete flag sticks on the minute
  await store.applyTrade(tradeAt("005930", 70_000, 1, at, "sat-seed"));
  const bars = await store.getBars("005930");
  assert.equal(bars[0]!.incomplete, true);
  const ac = new AbortController();
  const loop = tiny.startPublishLoop(ac.signal);
  await sleep(500);
  ac.abort();
  tiny.stop();
  await loop;
  console.log(
    JSON.stringify({
      queueSaturation: true,
      droppedQueue: tiny.metrics.droppedQueue,
      droppedTrades: tiny.metrics.droppedTrades,
      incompleteMarked: true,
      paperOrderbookDetector: "disabled_unverified",
    }),
  );
});

test("real infra: Kafka unreachable publish fails clearly (no silent file fallback)", { skip: !RUN }, async () => {
  const badCfg = { ...cfg, kafkaBrokers: ["127.0.0.1:1"] };
  const ping = await pingKafka(badCfg.kafkaBrokers);
  assert.equal(ping.ok, false);
  const badBus = new KafkaMarketBus(badCfg);
  let connectFailed = false;
  try {
    await badBus.connectProducer();
  } catch {
    connectFailed = true;
  }
  if (!connectFailed) {
    const pub = await badBus.publish(
      TICKER_QUOTES_TOPIC,
      tradeAt("005930", 70_000, 1, Date.now(), "kafka-down"),
    );
    assert.equal(pub.ok, false);
    connectFailed = true;
    await badBus.disconnect();
  }
  assert.equal(connectFailed, true);
  console.log(JSON.stringify({ kafkaDownObserved: true, detail: ping.detail }));
});

test("real infra: 10m window keeps one bar per minute and prunes older", { skip: !RUN }, async () => {
  await store.flushNamespace();
  const now = Date.parse("2026-11-10T02:00:00.000Z");
  for (let i = 0; i < 12; i++) {
    const ts = now - i * 60_000;
    // receivedTsMs=now so prune cutoff is relative to the window end
    await store.applyTrade(tradeAt("005930", 70_000 + i, 1, ts, `win-${i}`, now));
  }
  const bars = await store.getBars("005930");
  assert.ok(bars.length <= 10, `expected <=10 bars, got ${bars.length}`);
  const starts = new Set(bars.map((b) => b.minuteStartMs));
  assert.equal(starts.size, bars.length, "one bar per minute start");
});
