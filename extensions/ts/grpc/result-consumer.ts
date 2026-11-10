/**
 * Consume Kafka backtest-results → GetBacktestJob → observation store → offset commit.
 *
 * Offset is committed only after observation apply succeeds.
 * Transient gRPC failures do not advance the offset (no head-of-line skip).
 */
import { Kafka, logLevel, type EachMessagePayload } from "kafkajs";
import { TradingAnalysisClient } from "./client.ts";
import { ObservationStore } from "./observation-store.ts";
import {
  BACKTEST_RESULTS_TOPIC,
  RESULT_CONSUMER_GROUP,
  parseResultEvent,
  type BacktestResultEvent,
} from "./result-events.ts";

export type ResultConsumerStats = {
  consumed: number;
  applied: number;
  duplicates: number;
  grpcErrors: number;
  crashed: boolean;
};

export class BacktestResultConsumer {
  private readonly kafka: Kafka;
  private consumer: ReturnType<Kafka["consumer"]> | null = null;

  constructor(
    private readonly brokers: string[],
    private readonly grpcAddr: string,
    private readonly observations: ObservationStore,
    private readonly opts?: {
      groupId?: string;
      topic?: string;
      crashAfterStoreBeforeCommit?: boolean;
      /** Only crash when this jobId is stored (test hook). */
      crashOnJobId?: string;
      grpcDeadlineMs?: number;
    },
  ) {
    this.kafka = new Kafka({
      clientId: "ext-backtest-result-consumer",
      brokers,
      logLevel: logLevel.ERROR,
      connectionTimeout: 5_000,
    });
  }

  async run(opts: {
    signal?: AbortSignal;
    abort?: () => void;
    maxEvents?: number;
    fromBeginning?: boolean;
    onEvent?: (e: BacktestResultEvent, applied: boolean) => void;
  }): Promise<ResultConsumerStats> {
    const stats: ResultConsumerStats = {
      consumed: 0,
      applied: 0,
      duplicates: 0,
      grpcErrors: 0,
      crashed: false,
    };
    const topic = this.opts?.topic ?? BACKTEST_RESULTS_TOPIC;
    this.consumer = this.kafka.consumer({
      groupId: this.opts?.groupId ?? `${RESULT_CONSUMER_GROUP}-${Date.now()}`,
      sessionTimeout: 15_000,
    });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic,
      fromBeginning: opts.fromBeginning ?? true,
    });

    const grpc = new TradingAnalysisClient(this.grpcAddr, {
      deadlineMs: this.opts?.grpcDeadlineMs ?? 5_000,
    });

    let rejectRun!: (err: Error) => void;
    try {
      const failed = new Promise<void>((_resolve, reject) => {
        rejectRun = reject;
        this.consumer!.run({
          autoCommit: false,
          eachMessage: async (payload: EachMessagePayload) => {
            if (opts.signal?.aborted) return;
            const raw = payload.message.value?.toString("utf8");
            if (!raw) return;
            const event = parseResultEvent(raw);
            stats.consumed += 1;

            let job;
            try {
              job = await grpc.get(event.jobId);
            } catch (err) {
              stats.grpcErrors += 1;
              const e = err as { code?: number; message?: string };
              // Permanent miss (other store / deleted): skip + commit so the partition is not blocked.
              if (e.code === 5 /* NOT_FOUND */) {
                opts.onEvent?.(event, false);
                const next = (BigInt(payload.message.offset) + 1n).toString();
                await this.consumer!.commitOffsets([
                  {
                    topic: payload.topic,
                    partition: payload.partition,
                    offset: next,
                  },
                ]);
                if (opts.maxEvents != null && stats.consumed >= opts.maxEvents) {
                  setTimeout(() => opts.abort?.(), 20);
                }
                return;
              }
              // Transient gRPC failure — do not commit; allow redelivery after recovery.
              const wrapped = err instanceof Error ? err : new Error(String(err));
              rejectRun(wrapped);
              throw wrapped;
            }

            const { applied } = this.observations.apply(event, job);
            if (applied) stats.applied += 1;
            else stats.duplicates += 1;
            opts.onEvent?.(event, applied);

            if (
              this.opts?.crashAfterStoreBeforeCommit &&
              (!this.opts.crashOnJobId || this.opts.crashOnJobId === event.jobId)
            ) {
              stats.crashed = true;
              const crash = new Error("CRASH_AFTER_STORE_BEFORE_COMMIT");
              rejectRun(crash);
              throw crash;
            }

            const next = (BigInt(payload.message.offset) + 1n).toString();
            await this.consumer!.commitOffsets([
              {
                topic: payload.topic,
                partition: payload.partition,
                offset: next,
              },
            ]);

            if (opts.maxEvents != null && stats.consumed >= opts.maxEvents) {
              setTimeout(() => opts.abort?.(), 20);
            }
          },
        }).catch((err) => {
          rejectRun(err instanceof Error ? err : new Error(String(err)));
        });
      });

      const aborted = new Promise<void>((resolve) => {
        if (!opts.signal) return;
        if (opts.signal.aborted) return resolve();
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      await Promise.race([failed, aborted]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CRASH_AFTER_STORE_BEFORE_COMMIT")) {
        stats.crashed = true;
      } else {
        throw err;
      }
    } finally {
      grpc.close();
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
    return stats;
  }
}
