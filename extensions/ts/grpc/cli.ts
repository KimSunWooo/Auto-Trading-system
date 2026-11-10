#!/usr/bin/env npx tsx
/**
 * TypeScript CLI → Python TradingAnalysis gRPC server.
 *
 *   npx tsx extensions/ts/grpc/cli.ts submit --dataset synthetic-v0 --key demo-1
 *   npx tsx extensions/ts/grpc/cli.ts get --job <jobId>
 *   npx tsx extensions/ts/grpc/cli.ts run --dataset synthetic-v0 --key demo-run
 */
import { TradingAnalysisClient, isServiceError } from "./client.ts";
import { ALLOWED_DATASET_IDS, loadGrpcConfig } from "./config.ts";

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
    if (cmd === "submit") {
      const datasetId = arg("--dataset", "synthetic-v0");
      const key = arg("--key", `cli-${Date.now()}`);
      if (!(ALLOWED_DATASET_IDS as readonly string[]).includes(datasetId)) {
        throw new Error(`dataset_id not in catalog: ${datasetId}`);
      }
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

    if (cmd === "help" || has("--help")) {
      console.log(`Usage:
  submit --dataset synthetic-v0 --key <idem>
  get --job <jobId>
  run --dataset synthetic-v0 --key <idem>
Addr: ${cfg.addr}
Allowed datasets: ${ALLOWED_DATASET_IDS.join(", ")}
UploadBars / Kafka result notify: deferred`);
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
