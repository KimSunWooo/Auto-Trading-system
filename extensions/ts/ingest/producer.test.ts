import assert from "node:assert/strict";
import test from "node:test";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { MemoryBus, TICKER_QUOTES_TOPIC } from "../shared/file-bus.ts";
import { QuoteIngestProducer } from "./producer.ts";
import { UiQuoteAggregator } from "../redis/aggregator.ts";
import { BoundedQueue } from "./bounded-queue.ts";

test("bounded queue coalesces ORDERBOOK under capacity pressure", () => {
  const q = new BoundedQueue<{ kind: string; symbol: string; version: number }>(2);
  q.enqueue({ kind: "ORDERBOOK", symbol: "005930", version: 1 }, {
    mergeKey: "ORDERBOOK:005930",
    keyOf: (e) => `${e.kind}:${e.symbol}`,
  });
  q.enqueue({ kind: "ORDERBOOK", symbol: "005930", version: 2 }, {
    mergeKey: "ORDERBOOK:005930",
    keyOf: (e) => `${e.kind}:${e.symbol}`,
  });
  q.enqueue({ kind: "TRADE", symbol: "005930", version: 3 });
  assert.equal(q.size, 2);
  const drained = q.drain(10);
  assert.equal(drained.find((e) => e.kind === "ORDERBOOK")?.version, 2);
});

test("fixture ingest publishes TRADE events and UI aggregator builds bars", async () => {
  const bus = new MemoryBus();
  const producer = new QuoteIngestProducer(bus, { emitOrderBookStub: false });
  const ac = new AbortController();
  const loop = producer.startPublishLoop(ac.signal);

  const frame = buildH0stCnt0Fixture({
    MKSC_SHRN_ISCD: "005930",
    STCK_PRPR: "70000",
    CNTG_VOL: "10",
    BSOP_DATE: "20261110",
  });
  producer.onRawFrame(frame, Date.parse("2026-11-10T01:30:15.000Z"));
  producer.onRawFrame(
    buildH0stCnt0Fixture({
      MKSC_SHRN_ISCD: "005930",
      STCK_PRPR: "70100",
      CNTG_VOL: "5",
      BSOP_DATE: "20261110",
      STCK_CNTG_HOUR: "103016",
    }),
    Date.parse("2026-11-10T01:30:16.000Z"),
  );

  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  producer.stop();
  await loop;

  assert.ok(producer.metrics.published >= 2);
  const events = await bus.readAll(TICKER_QUOTES_TOPIC);
  assert.ok(events.every((e) => e.kind === "TRADE"));
  assert.ok(events.every((e) => e.partitionKey === "KR:005930"));

  const agg = new UiQuoteAggregator(bus);
  await agg.consumeAll();
  const latest = agg.store.getLatest("005930");
  assert.ok(latest);
  assert.equal(latest!.price, 70_100);
  const bars = agg.store.getBars("005930");
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.volume, 15);
  assert.equal(bars[0]!.incomplete, false);
});

test("duplicate trade eventId does not double-count volume", async () => {
  const bus = new MemoryBus();
  const producer = new QuoteIngestProducer(bus);
  const frame = buildH0stCnt0Fixture({
    MKSC_SHRN_ISCD: "035720",
    STCK_PRPR: "45200",
    CNTG_VOL: "3",
    BSOP_DATE: "20261110",
  });
  const ac = new AbortController();
  const loop = producer.startPublishLoop(ac.signal);
  producer.onRawFrame(frame, 1_000);
  producer.onRawFrame(frame, 1_000); // same content → same eventId path after version differs...
  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  producer.stop();
  await loop;

  const agg = new UiQuoteAggregator(bus);
  // Force duplicate apply
  const events = await bus.readAll(TICKER_QUOTES_TOPIC);
  assert.ok(events[0]);
  agg.apply(events[0]!);
  agg.apply(events[0]!);
  assert.equal(agg.stats.duplicates, 1);
  assert.equal(agg.store.getBars("035720")[0]!.volume, 3);
});
