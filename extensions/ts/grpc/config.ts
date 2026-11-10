/**
 * Local TradingAnalysis gRPC client config (extensions only).
 * Server/worker are separate Python processes.
 */
export const DEFAULT_GRPC_ADDR = "127.0.0.1:50051";
export const DEFAULT_RPC_DEADLINE_MS = 5_000;
export const DEFAULT_POLL_MS = 200;
export const DEFAULT_QUEUE_CAP = 32;

/** Allowed dataset IDs — mirrors Python datasets.DATASETS (no path inputs). */
export const ALLOWED_DATASET_IDS = ["synthetic-v0", "synthetic-v0-short"] as const;
export type AllowedDatasetId = (typeof ALLOWED_DATASET_IDS)[number];

export function loadGrpcConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    addr: env.EXT_GRPC_ADDR ?? DEFAULT_GRPC_ADDR,
    deadlineMs: Number(env.EXT_GRPC_DEADLINE_MS ?? DEFAULT_RPC_DEADLINE_MS),
    pollMs: Number(env.EXT_GRPC_POLL_MS ?? DEFAULT_POLL_MS),
    protoPath:
      env.EXT_PROTO_PATH ??
      new URL("../../proto/trading_analysis.proto", import.meta.url).pathname,
  };
}
