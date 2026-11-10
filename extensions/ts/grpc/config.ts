/**
 * Local TradingAnalysis gRPC client config (extensions only).
 * Server/worker are separate Python processes.
 *
 * Publisher note: grpc-up.sh runs Python `ats_research.outbox_publisher`
 * (kafka-python-ng). TS adapters/consumers use kafkajs — intentional split.
 */
export const DEFAULT_GRPC_ADDR = "127.0.0.1:50051";
export const DEFAULT_RPC_DEADLINE_MS = 5_000;
export const DEFAULT_POLL_MS = 200;
export const DEFAULT_QUEUE_CAP = 32;

/** Builtin synthetic IDs (uploads get content-addressed upload-* ids). */
export const BUILTIN_DATASET_IDS = ["synthetic-v0", "synthetic-v0-short"] as const;
/** @deprecated use BUILTIN_DATASET_IDS — uploads are also valid server-side */
export const ALLOWED_DATASET_IDS = BUILTIN_DATASET_IDS;
export type AllowedDatasetId = (typeof BUILTIN_DATASET_IDS)[number];

export const DEFAULT_UPLOAD_BATCH = 50;
export const DEFAULT_UPLOAD_SEND_BUFFER = 3;

export function loadGrpcConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    addr: env.EXT_GRPC_ADDR ?? DEFAULT_GRPC_ADDR,
    deadlineMs: Number(env.EXT_GRPC_DEADLINE_MS ?? DEFAULT_RPC_DEADLINE_MS),
    pollMs: Number(env.EXT_GRPC_POLL_MS ?? DEFAULT_POLL_MS),
    uploadBatch: Number(env.EXT_UPLOAD_BATCH ?? DEFAULT_UPLOAD_BATCH),
    uploadSendBuffer: Number(env.EXT_UPLOAD_CLIENT_SEND_BUFFER ?? DEFAULT_UPLOAD_SEND_BUFFER),
    protoPath:
      env.EXT_PROTO_PATH ??
      new URL("../../proto/trading_analysis.proto", import.meta.url).pathname,
  };
}
