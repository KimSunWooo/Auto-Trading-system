/**
 * TypeScript TradingAnalysis gRPC client (loads extensions/proto at runtime).
 * Tools: @grpc/grpc-js@1.12.6 + @grpc/proto-loader@0.7.13
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  ALLOWED_DATASET_IDS,
  DEFAULT_RPC_DEADLINE_MS,
  loadGrpcConfig,
  type AllowedDatasetId,
} from "./config.ts";

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

  constructor(addr?: string, opts?: { protoPath?: string; deadlineMs?: number }) {
    const cfg = loadGrpcConfig();
    const target = addr ?? cfg.addr;
    const protoPath = opts?.protoPath ?? cfg.protoPath ?? DEFAULT_PROTO;
    const Ctor = loadPackage(protoPath);
    this.client = new Ctor(target, grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": 4 * 1024 * 1024,
      "grpc.keepalive_time_ms": 10_000,
    }) as unknown as GrpcClient;
    this.deadlineMs = opts?.deadlineMs ?? cfg.deadlineMs ?? DEFAULT_RPC_DEADLINE_MS;
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
    if (!(ALLOWED_DATASET_IDS as readonly string[]).includes(input.datasetId)) {
      return Promise.reject(
        Object.assign(new Error(`unknown_dataset_id:${input.datasetId}`), {
          code: grpc.status.NOT_FOUND,
        }),
      );
    }
    const c = input.candidate ?? {};
    const req = {
      idempotencyKey: input.idempotencyKey,
      datasetId: input.datasetId as AllowedDatasetId,
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
}

export function isServiceError(err: unknown): err is grpc.ServiceError {
  return Boolean(err && typeof err === "object" && "code" in (err as object));
}

export { grpc };
