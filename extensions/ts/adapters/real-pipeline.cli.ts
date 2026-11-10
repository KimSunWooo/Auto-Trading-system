#!/usr/bin/env npx tsx
/**
 * Explicit real-infra pipeline. Fails if Kafka/Redis unreachable.
 *   EXTENSIONS_REAL_INFRA=1 npx tsx extensions/ts/adapters/real-pipeline.cli.ts
 */
import {
  consumeKafkaToRedis,
  loadFixtureFrames,
  publishFixturesToKafka,
  requireRealInfra,
} from "./pipeline.ts";
import { EXT_CONSUMER_GROUP } from "../shared/config.ts";

async function main(): Promise<void> {
  const cfg = await requireRealInfra();
  const frames = loadFixtureFrames();
  const pub = await publishFixturesToKafka({ cfg, frames });
  console.log(
    JSON.stringify({
      phase: "publish",
      realAdapters: true,
      published: pub.published,
      metrics: pub.producer.metrics,
      paperOrderbookDetector: "disabled_unverified",
    }),
  );

  const groupId = `${EXT_CONSUMER_GROUP}-cli-${Date.now()}`;
  const cons = await consumeKafkaToRedis({
    cfg,
    groupId,
    maxMessages: Math.max(frames.length, pub.published),
    fromBeginning: true,
    idleMs: 8_000,
  });

  const latest = await cons.store.getLatest("005930");
  const bars = await cons.store.getBars("005930");
  console.log(
    JSON.stringify(
      {
        phase: "consume",
        realAdapters: true,
        stats: cons.stats,
        latest005930: latest,
        bars005930: bars,
        dedupeTtlSec: 86400,
        reprocessSafe: "eventId SET checked atomically before volume add",
      },
      null,
      2,
    ),
  );

  await cons.store.close();
  await cons.bus.disconnect();
  await pub.bus.disconnect();
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, realAdapters: true, error: String(err) }));
  process.exit(1);
});
