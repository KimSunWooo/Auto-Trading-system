#!/usr/bin/env npx tsx
/**
 * TypeScript CLI → Python TradingAnalysis gRPC server.
 *
 *   npx tsx extensions/ts/grpc/cli.ts upload --file extensions/fixtures/ohlcv-005930-1d.jsonl --interval 1d
 *   npx tsx extensions/ts/grpc/cli.ts submit --dataset <id> --key demo-1
 *   npx tsx extensions/ts/grpc/cli.ts get --job <jobId>
 *   npx tsx extensions/ts/grpc/cli.ts run --dataset synthetic-v0 --key demo-run
 */
import path from "node:path";
import { TradingAnalysisClient, isServiceError } from "./client.ts";
import { BUILTIN_DATASET_IDS, loadGrpcConfig } from "./config.ts";
import { readOhlcvJsonl } from "./ohlcv-file.ts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "help";
  const cfg = loadGrpcConfig();
  const client = new TradingAnalysisClient(cfg.addr);

  try {
    if (cmd === "upload") {
      const file = arg("--file");
      if (!file) throw new Error("--file required (local OHLCV JSONL)");
      const interval = arg("--interval", "1d");
      const batchSize = Number(arg("--batch", String(cfg.uploadBatch)));
      const bars = [];
      let ticker = arg("--ticker", "");
      for await (const bar of readOhlcvJsonl(path.resolve(file))) {
        if (!ticker) ticker = bar.ticker;
        bars.push(bar);
      }
      if (!ticker) throw new Error("ticker missing in file / --ticker");
      const uploaded = await client.uploadBars({
        bars,
        ticker,
        interval,
        batchSize,
        sendBuffer: cfg.uploadSendBuffer,
        rpcDeadlineMs: Number(arg("--deadline-ms", "60000")),
      });
      console.log(
        JSON.stringify(
          {
            phase: "upload",
            realGrpc: true,
            file: path.resolve(file),
            batchSize,
            sendBuffer: cfg.uploadSendBuffer,
            ...uploaded,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "submit") {
      const datasetId = arg("--dataset", "synthetic-v0");
      const key = arg("--key", `cli-${Date.now()}`);
      const res = await client.submit({
        idempotencyKey: key,
        datasetId,
        candidate: {
          candidateId: arg("--candidate", "ma-5-20"),
          fastMa: Number(arg("--fast", "5")),
          slowMa: Number(arg("--slow", "20")),
          buyPct: Number(arg("--buy", "0.1")),
          stopLossPct: Number(arg("--stop", "0.05")),
          dataVersion: datasetId,
        },
      });
      console.log(JSON.stringify({ phase: "submit", realGrpc: true, ...res }, null, 2));
      return;
    }

    if (cmd === "get") {
      const jobId = arg("--job");
      if (!jobId) throw new Error("--job required");
      const job = await client.get(jobId);
      console.log(JSON.stringify({ phase: "get", realGrpc: true, job }, null, 2));
      return;
    }

    if (cmd === "run") {
      const datasetId = arg("--dataset", "synthetic-v0");
      const key = arg("--key", `cli-run-${Date.now()}`);
      const submitted = await client.submit({
        idempotencyKey: key,
        datasetId,
        candidate: {
          candidateId: "ma-5-20",
          fastMa: 5,
          slowMa: 20,
          buyPct: 0.1,
          stopLossPct: 0.05,
          dataVersion: datasetId,
        },
      });
      const job = await client.waitForTerminal(submitted.jobId, {
        timeoutMs: Number(arg("--timeout-ms", "60000")),
      });
      console.log(
        JSON.stringify(
          {
            phase: "run",
            realGrpc: true,
            submit: submitted,
            job,
            note: "Python metrics are candidate-search only; ATS BacktestRunner is execution truth",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "upload-run") {
      const file = arg("--file", "extensions/fixtures/ohlcv-005930-1d.jsonl");
      const interval = arg("--interval", "1d");
      const bars = [];
      let ticker = "";
      for await (const bar of readOhlcvJsonl(path.resolve(file))) {
        if (!ticker) ticker = bar.ticker;
        bars.push(bar);
      }
      const uploaded = await client.uploadBars({
        bars,
        ticker,
        interval,
        batchSize: Number(arg("--batch", "10")),
        sendBuffer: cfg.uploadSendBuffer,
      });
      const submitted = await client.submit({
        idempotencyKey: arg("--key", `upload-run-${Date.now()}`),
        datasetId: uploaded.datasetId,
        candidate: {
          candidateId: "ma-5-20",
          fastMa: 5,
          slowMa: 20,
          buyPct: 0.1,
          stopLossPct: 0.05,
          dataVersion: uploaded.dataVersion,
        },
      });
      const job = await client.waitForTerminal(submitted.jobId, { timeoutMs: 60_000 });
      console.log(
        JSON.stringify(
          {
            phase: "upload-run",
            realGrpc: true,
            upload: uploaded,
            submit: submitted,
            job,
            dataVersionMatch: job.candidate.dataVersion === uploaded.dataVersion,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (cmd === "help" || has("--help")) {
      console.log(`Usage:
  upload --file <ohlcv.jsonl> --interval 1d [--batch 50]
  upload-run --file <ohlcv.jsonl> --interval 1d
  submit --dataset <id> --key <idem>
  get --job <jobId>
  run --dataset synthetic-v0 --key <idem>
Addr: ${cfg.addr}
Builtin datasets: ${BUILTIN_DATASET_IDS.join(", ")} (+ upload-* after UploadBars)
Publisher: Python outbox_publisher (kafka-python-ng); TS uses kafkajs for consumers`);
      return;
    }

    throw new Error(`unknown command: ${cmd}`);
  } catch (err) {
    const payload: Record<string, unknown> = {
      ok: false,
      realGrpc: true,
      error: err instanceof Error ? err.message : String(err),
    };
    if (isServiceError(err)) {
      payload.code = err.code;
      payload.details = err.details;
    }
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main();
