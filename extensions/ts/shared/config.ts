/**
 * Extension runtime config. Real Kafka/Redis adapters are OFF unless
 * EXTENSIONS_REAL_INFRA=1 (or --real CLI flag) is set.
 */
export const TICKER_QUOTES_TOPIC = "ticker-quotes";
export const EXT_CONSUMER_GROUP = "ext-ui-ohlcv-v1";

/** Dedupe SET TTL — must cover max Kafka reprocess window. */
export const DEDUPE_TTL_SEC = 24 * 60 * 60;
/** UI OHLCV retention. */
export const OHLCV_WINDOW_MS = 10 * 60_000;
export const OHLCV_WINDOW_MINUTES = 10;

export type RealInfraConfig = {
  enabled: boolean;
  kafkaBrokers: string[];
  kafkaClientId: string;
  redisUrl: string;
  publishAcks: -1 | 0 | 1;
  publishTimeoutMs: number;
  publishRetries: number;
  queueCapacity: number;
  batchSize: number;
  batchWaitMs: number;
};

export function loadRealInfraConfig(env: NodeJS.ProcessEnv = process.env): RealInfraConfig {
  const enabled =
    env.EXTENSIONS_REAL_INFRA === "1" ||
    env.EXTENSIONS_REAL_INFRA === "true" ||
    process.argv.includes("--real");
  return {
    enabled,
    kafkaBrokers: (env.EXT_KAFKA_BROKERS ?? "127.0.0.1:19092").split(",").map((s) => s.trim()),
    kafkaClientId: env.EXT_KAFKA_CLIENT_ID ?? "ext-quote-ingest",
    redisUrl: env.EXT_REDIS_URL ?? "redis://127.0.0.1:16379",
    publishAcks: -1,
    publishTimeoutMs: Number(env.EXT_PUBLISH_TIMEOUT_MS ?? 5_000),
    publishRetries: Number(env.EXT_PUBLISH_RETRIES ?? 3),
    queueCapacity: Number(env.EXT_QUEUE_CAPACITY ?? 2_000),
    batchSize: Number(env.EXT_BATCH_SIZE ?? 50),
    batchWaitMs: Number(env.EXT_BATCH_WAIT_MS ?? 25),
  };
}

export function assertRealInfraOrThrow(cfg: RealInfraConfig): void {
  if (!cfg.enabled) {
    throw new Error(
      "Real Kafka/Redis adapters require EXTENSIONS_REAL_INFRA=1 (or --real). Refusing silent file fallback.",
    );
  }
}
