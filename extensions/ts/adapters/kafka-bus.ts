/**
 * Real Kafka (Redpanda) MarketEventBus adapter.
 * Fails hard when brokers unreachable — never falls back to file bus.
 */
import { Kafka, logLevel, type Producer, type Consumer, type EachMessagePayload } from "kafkajs";
import type { MarketEvent } from "../shared/types.ts";
import type { BusPublishResult, MarketEventBus } from "../shared/file-bus.ts";
import {
  EXT_CONSUMER_GROUP,
  TICKER_QUOTES_TOPIC,
  type RealInfraConfig,
} from "../shared/config.ts";

export type KafkaConsumeHandler = (input: {
  event: MarketEvent;
  topic: string;
  partition: number;
  offset: string;
}) => Promise<void>;

export class KafkaMarketBus implements MarketEventBus {
  readonly adapter = "kafka" as const;
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;

  constructor(private readonly cfg: RealInfraConfig) {
    this.kafka = new Kafka({
      clientId: cfg.kafkaClientId,
      brokers: cfg.kafkaBrokers,
      logLevel: logLevel.ERROR,
      connectionTimeout: 5_000,
      requestTimeout: cfg.publishTimeoutMs,
      retry: { retries: cfg.publishRetries },
    });
  }

  async connectProducer(): Promise<void> {
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    await this.consumer?.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
    this.consumer = null;
    this.producer = null;
  }

  async publish(topic: string, event: MarketEvent): Promise<BusPublishResult> {
    if (!this.producer) {
      return { ok: false, error: "kafka_producer_not_connected" };
    }
    try {
      const result = await this.producer.send({
        topic,
        acks: this.cfg.publishAcks,
        timeout: this.cfg.publishTimeoutMs,
        messages: [
          {
            key: event.partitionKey,
            value: JSON.stringify(event),
            headers: {
              kind: event.kind,
              eventId: event.eventId,
            },
          },
        ],
      });
      const offset = Number(result[0]?.baseOffset ?? 0);
      return { ok: true, offset };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Test helper — drain topic from beginning (does not advance a durable group). */
  async readAll(topic: string): Promise<MarketEvent[]> {
    const consumer = this.kafka.consumer({
      groupId: `${EXT_CONSUMER_GROUP}-snapshot-${Date.now()}`,
    });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const out: MarketEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 2_500);
      consumer
        .run({
          autoCommit: false,
          eachMessage: async ({ message }) => {
            if (!message.value) return;
            out.push(JSON.parse(message.value.toString("utf8")) as MarketEvent);
            clearTimeout(timer);
            // Reset idle timer after each message
            setTimeout(() => resolve(), 800);
          },
        })
        .catch(reject);
    });
    await done;
    await consumer.disconnect();
    return out;
  }

  /**
   * Durable consumer: handler must finish Redis apply BEFORE we commit.
   * Set crashBeforeCommit=true in tests to simulate kill after Redis success.
   *
   * Note: kafkajs 2.x `consumer.run()` resolves when the fetch loop *starts*,
   * not when it stops. Callers must keep this method alive via `signal` (or
   * until `onHandlerError` / crash) — we only stop in `finally`.
   */
  async runConsumer(opts: {
    topic?: string;
    groupId?: string;
    fromBeginning?: boolean;
    handler: KafkaConsumeHandler;
    signal?: AbortSignal;
    crashBeforeCommit?: boolean;
    onReady?: () => void;
  }): Promise<void> {
    const topic = opts.topic ?? TICKER_QUOTES_TOPIC;
    this.consumer = this.kafka.consumer({
      groupId: opts.groupId ?? EXT_CONSUMER_GROUP,
      sessionTimeout: 15_000,
    });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic,
      fromBeginning: opts.fromBeginning ?? true,
    });
    opts.onReady?.();

    let handlerError: Error | null = null;
    let rejectRun!: (err: Error) => void;
    try {
      // kafkajs run() settles when the fetch loop *starts* — keep alive via signal / handler fail.
      const failed = new Promise<void>((_resolve, reject) => {
        rejectRun = reject;
        this.consumer!.run({
          autoCommit: false,
          eachMessage: async (payload: EachMessagePayload) => {
            if (opts.signal?.aborted || handlerError) return;
            const raw = payload.message.value?.toString("utf8");
            if (!raw) return;
            const event = JSON.parse(raw) as MarketEvent;
            try {
              await opts.handler({
                event,
                topic: payload.topic,
                partition: payload.partition,
                offset: payload.message.offset,
              });
              if (opts.crashBeforeCommit) {
                throw new Error("CRASH_BEFORE_OFFSET_COMMIT");
              }
              // Commit only after handler (Redis apply) succeeded.
              const next = (BigInt(payload.message.offset) + 1n).toString();
              await this.consumer!.commitOffsets([
                {
                  topic: payload.topic,
                  partition: payload.partition,
                  offset: next,
                },
              ]);
            } catch (err) {
              handlerError = err instanceof Error ? err : new Error(String(err));
              rejectRun(handlerError);
              throw handlerError;
            }
          },
        }).catch((err) => {
          if (!handlerError) {
            handlerError = err instanceof Error ? err : new Error(String(err));
          }
          rejectRun(handlerError);
        });
      });

      const aborted = new Promise<void>((resolve) => {
        if (!opts.signal) return; // never resolves — caller must stop externally
        if (opts.signal.aborted) return resolve();
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      await Promise.race([failed, aborted]);
      if (handlerError) throw handlerError;
    } finally {
      try {
        await this.consumer?.stop();
      } catch {
        /* ignore */
      }
      try {
        await this.consumer?.disconnect();
      } catch {
        /* ignore */
      }
      this.consumer = null;
    }
  }
}

export async function pingKafka(brokers: string[]): Promise<{ ok: boolean; detail: string }> {
  const kafka = new Kafka({
    clientId: "ext-ping",
    brokers,
    connectionTimeout: 3_000,
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  try {
    await admin.connect();
    const id = await admin.describeCluster();
    await admin.disconnect();
    return { ok: true, detail: `brokers=${brokers.join(",")} clusterId=${id.clusterId}` };
  } catch (err) {
    await admin.disconnect().catch(() => undefined);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
