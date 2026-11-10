/**
 * TypeScript TradingAnalysis gRPC client (loads extensions/proto at runtime).
 * Tools: @grpc/grpc-js@1.12.6 + @grpc/proto-loader@0.7.13
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  DEFAULT_RPC_DEADLINE_MS,
  DEFAULT_UPLOAD_SEND_BUFFER,
  loadGrpcConfig,
} from "./config.ts";
import type { OhlcvBar } from "./ohlcv-file.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROTO = path.resolve(__dirname, "../../proto/trading_analysis.proto");

export type BacktestCandidate = {
  candidateId?: string;
  strategyKind?: string;
  fastMa?: number;
  slowMa?: number;
  buyPct?: number;
  stopLossPct?: number;
  dataVersion?: string;
};

export type BacktestMetrics = {
  totalReturnPct: number;
  mddPct: number;
  trades: number;
  winRatePct: number;
};

export type SubmitResult = { jobId: string; status: string };
export type JobResult = {
  jobId: string;
  status: string;
  error: string;
  candidate: BacktestCandidate;
  metrics: BacktestMetrics;
  updatedAtUnixMs: number;
};

export type UploadResult = {
  datasetId: string;
  acceptedBars: number;
  bytesReceived: number;
  dataVersion: string;
  contentHash: string;
  rowCount: number;
  startTMs: number;
  endTMs: number;
  deduped: boolean;
};

type ClientStreamingCall = {
  write: (msg: Record<string, unknown>, cb?: (err?: Error | null) => void) => boolean;
  end: () => void;
  cancel: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

type GrpcClient = {
  SubmitBacktest: (
    req: Record<string, unknown>,
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  GetBacktestJob: (
    req: Record<string, unknown>,
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => void;
  UploadBars: (
    md: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void,
  ) => ClientStreamingCall;
  close: () => void;
};

function loadPackage(protoPath: string): grpc.ServiceClientConstructor {
  const def = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as Record<string, unknown>;
  const ats = pkg["ats"] as Record<string, unknown>;
  const trading = ats["trading_analysis"] as Record<string, unknown>;
  const v1 = trading["v1"] as Record<string, unknown>;
  return v1["TradingAnalysis"] as grpc.ServiceClientConstructor;
}

export class TradingAnalysisClient {
  readonly adapter = "grpc" as const;
  private readonly client: GrpcClient;
  private readonly deadlineMs: number;
  private readonly sendBuffer: number;

  constructor(
    addr?: string,
    opts?: { protoPath?: string; deadlineMs?: number; uploadSendBuffer?: number },
  ) {
    const cfg = loadGrpcConfig();
    const target = addr ?? cfg.addr;
    const protoPath = opts?.protoPath ?? cfg.protoPath ?? DEFAULT_PROTO;
    const Ctor = loadPackage(protoPath);
    this.client = new Ctor(target, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": 4 * 1024 * 1024,
      "grpc.max_send_message_length": 4 * 1024 * 1024,
      "grpc.keepalive_time_ms": 10_000,
    }) as unknown as GrpcClient;
    this.deadlineMs = opts?.deadlineMs ?? cfg.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
    this.sendBuffer = opts?.uploadSendBuffer ?? cfg.uploadSendBuffer ?? DEFAULT_UPLOAD_SEND_BUFFER;
  }

  close(): void {
    this.client.close();
  }

  private deadline(ms = this.deadlineMs): grpc.CallOptions {
    return { deadline: Date.now() + ms };
  }

  submit(input: {
    idempotencyKey: string;
    datasetId: string;
    candidate?: BacktestCandidate;
    deadlineUnixMs?: number;
    tags?: Record<string, string>;
    rpcDeadlineMs?: number;
  }): Promise<SubmitResult> {
    // Server validates catalog (builtin + uploaded). No client-side path allowlist.
    const c = input.candidate ?? {};
    const req = {
      idempotencyKey: input.idempotencyKey,
      datasetId: input.datasetId,
      candidate: {
        candidateId: c.candidateId ?? "",
        strategyKind: c.strategyKind ?? "ma-cross",
        fastMa: c.fastMa ?? 5,
        slowMa: c.slowMa ?? 20,
        buyPct: c.buyPct ?? 0.1,
        stopLossPct: c.stopLossPct ?? 0.05,
        dataVersion: c.dataVersion ?? input.datasetId,
      },
      deadlineUnixMs: input.deadlineUnixMs ?? 0,
      tags: input.tags ?? {},
    };
    return new Promise((resolve, reject) => {
      this.client.SubmitBacktest(req, new grpc.Metadata(), this.deadline(input.rpcDeadlineMs), (err, res) => {
        if (err) return reject(err);
        resolve({ jobId: String(res.jobId), status: String(res.status) });
      });
    });
  }

  get(jobId: string, rpcDeadlineMs?: number): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      this.client.GetBacktestJob(
        { jobId },
        new grpc.Metadata(),
        this.deadline(rpcDeadlineMs),
        (err, res) => {
          if (err) return reject(err);
          const cand = (res.candidate ?? {}) as Record<string, unknown>;
          const metrics = (res.metrics ?? {}) as Record<string, unknown>;
          resolve({
            jobId: String(res.jobId),
            status: String(res.status),
            error: String(res.error ?? ""),
            candidate: {
              candidateId: String(cand.candidateId ?? ""),
              strategyKind: String(cand.strategyKind ?? ""),
              fastMa: Number(cand.fastMa ?? 0),
              slowMa: Number(cand.slowMa ?? 0),
              buyPct: Number(cand.buyPct ?? 0),
              stopLossPct: Number(cand.stopLossPct ?? 0),
              dataVersion: String(cand.dataVersion ?? ""),
            },
            metrics: {
              totalReturnPct: Number(metrics.totalReturnPct ?? 0),
              mddPct: Number(metrics.mddPct ?? 0),
              trades: Number(metrics.trades ?? 0),
              winRatePct: Number(metrics.winRatePct ?? 0),
            },
            updatedAtUnixMs: Number(res.updatedAtUnixMs ?? 0),
          });
        },
      );
    });
  }

  async waitForTerminal(
    jobId: string,
    opts?: { timeoutMs?: number; pollMs?: number },
  ): Promise<JobResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollMs = opts?.pollMs ?? loadGrpcConfig().pollMs;
    const t0 = Date.now();
    for (;;) {
      const job = await this.get(jobId);
      if (["SUCCEEDED", "FAILED", "EXPIRED"].includes(job.status)) return job;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`wait_timeout jobId=${jobId} lastStatus=${job.status}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Stream UploadBars with a bounded send buffer (backpressure).
   * When in-flight writes == sendBuffer, wait for drain before reading/sending more.
   */
  uploadBars(input: {
    bars: OhlcvBar[];
    ticker: string;
    interval: string;
    datasetIdHint?: string;
    batchSize?: number;
    clientDeadlineUnixMs?: number;
    rpcDeadlineMs?: number;
    sendBuffer?: number;
    /** Test: abort after N chunks written (before eof). */
    cancelAfterChunks?: number;
  }): Promise<UploadResult> {
    const batchSize = Math.max(1, input.batchSize ?? 50);
    const sendBuffer = Math.max(1, input.sendBuffer ?? this.sendBuffer);
    const chunks: OhlcvBar[][] = [];
    for (let i = 0; i < input.bars.length; i += batchSize) {
      chunks.push(input.bars.slice(i, i + batchSize));
    }
    if (!chunks.length) {
      return Promise.reject(Object.assign(new Error("empty_upload"), { code: grpc.status.INVALID_ARGUMENT }));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const call = this.client.UploadBars(
        new grpc.Metadata(),
        this.deadline(input.rpcDeadlineMs ?? Math.max(this.deadlineMs, 30_000)),
        (err, res) => {
          if (settled) return;
          settled = true;
          if (err) return reject(err);
          resolve({
            datasetId: String(res.datasetId),
            acceptedBars: Number(res.acceptedBars ?? 0),
            bytesReceived: Number(res.bytesReceived ?? 0),
            dataVersion: String(res.dataVersion ?? ""),
            contentHash: String(res.contentHash ?? ""),
            rowCount: Number(res.rowCount ?? 0),
            startTMs: Number(res.startTMs ?? 0),
            endTMs: Number(res.endTMs ?? 0),
            deduped: Boolean(res.deduped),
          });
        },
      );

      let inFlight = 0;
      let idx = 0;
      let writing = false;

      const pump = () => {
        if (settled || writing) return;
        writing = true;
        const step = () => {
          while (idx < chunks.length && inFlight < sendBuffer) {
            if (input.cancelAfterChunks != null && idx >= input.cancelAfterChunks) {
              call.cancel();
              if (!settled) {
                settled = true;
                reject(Object.assign(new Error("client_cancelled"), { code: grpc.status.CANCELLED }));
              }
              writing = false;
              return;
            }
            const batch = chunks[idx]!;
            const isLast = idx === chunks.length - 1;
            idx += 1;
            inFlight += 1;
            const ok = call.write(
              {
                datasetId: input.datasetIdHint ?? "",
                ticker: input.ticker,
                interval: input.interval,
                clientDeadlineUnixMs: input.clientDeadlineUnixMs ?? 0,
                eof: isLast,
                bars: batch.map((b) => ({
                  tMs: b.tMs,
                  ticker: b.ticker || input.ticker,
                  open: b.open,
                  high: b.high,
                  low: b.low,
                  close: b.close,
                  volume: b.volume,
                  incomplete: Boolean(b.incomplete),
                })),
              },
              (writeErr) => {
                inFlight = Math.max(0, inFlight - 1);
                if (writeErr && !settled) {
                  settled = true;
                  reject(writeErr);
                  return;
                }
                if (isLast) {
                  call.end();
                } else if (inFlight < sendBuffer) {
                  step();
                }
              },
            );
            if (!ok) {
              // Buffer full — wait for drain before continuing.
              call.on("drain", () => {
                inFlight = Math.max(0, inFlight); // drain does not decrement; callback does
                step();
              });
              break;
            }
          }
          writing = false;
        };
        step();
      };

      call.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      pump();
    });
  }
}

export function isServiceError(err: unknown): err is grpc.ServiceError {
  return Boolean(err && typeof err === "object" && "code" in (err as object));
}

export { grpc };
