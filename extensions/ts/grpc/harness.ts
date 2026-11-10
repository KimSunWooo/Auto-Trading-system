/**
 * Process harness for real local gRPC server + backtest worker.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_ROOT = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(EXT_ROOT, "..");

export type ProcHandle = {
  proc: ChildProcess;
  name: string;
  logPath: string;
};

function pythonEnv(store: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: [path.join(EXT_ROOT, "python"), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
    EXT_JOB_STORE: store,
  };
}

export async function waitPort(host: string, port: number, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port }, () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`port_timeout ${host}:${port}`);
    await sleep(100);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function freshStore(name: string): string {
  const dir = path.join(EXT_ROOT, ".bus", "jobs-test", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function startServer(opts: {
  store: string;
  bind: string;
  queueCap?: number;
}): ProcHandle {
  const runDir = path.join(EXT_ROOT, ".bus", "run");
  mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, `server-${process.pid}-${Date.now()}.log`);
  const out = openSync(logPath, "a");
  const proc = spawn(
    "python3",
    [
      "-m",
      "ats_research.grpc_server",
      "--bind",
      opts.bind,
      "--store",
      opts.store,
      "--queue-cap",
      String(opts.queueCap ?? 32),
    ],
    {
      cwd: REPO_ROOT,
      env: pythonEnv(opts.store),
      stdio: ["ignore", out, out],
      detached: false,
    },
  );
  return { proc, name: "grpc_server", logPath };
}

export function startWorker(opts: {
  store: string;
  workerId: string;
  leaseMs?: number;
  maxJobs?: number;
  crashAfterClaim?: boolean;
  delayMs?: number;
}): ProcHandle {
  const runDir = path.join(EXT_ROOT, ".bus", "run");
  mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, `worker-${opts.workerId}-${Date.now()}.log`);
  const out = openSync(logPath, "a");
  const args = [
    "-m",
    "ats_research.backtest_worker",
    "--store",
    opts.store,
    "--worker-id",
    opts.workerId,
    "--lease-ms",
    String(opts.leaseMs ?? 30_000),
    "--poll-ms",
    "100",
  ];
  if (opts.maxJobs) {
    args.push("--max-jobs", String(opts.maxJobs));
  }
  if (opts.crashAfterClaim) args.push("--crash-after-claim");
  if (opts.delayMs && opts.delayMs > 0) {
    args.push("--delay-ms", String(opts.delayMs));
  }
  const proc = spawn("python3", args, {
    cwd: REPO_ROOT,
    env: pythonEnv(opts.store),
    stdio: ["ignore", out, out],
  });
  return { proc, name: `worker:${opts.workerId}`, logPath };
}

export async function stopProc(h: ProcHandle | null | undefined, sig: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!h?.proc.pid) return;
  try {
    h.proc.kill(sig);
  } catch {
    /* ignore */
  }
  await sleep(150);
  try {
    h.proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

export function readLog(h: ProcHandle): string {
  if (!existsSync(h.logPath)) return "";
  return readFileSync(h.logPath, "utf8");
}

export function parseBind(bind: string): { host: string; port: number } {
  const [host, port] = bind.split(":");
  return { host: host || "127.0.0.1", port: Number(port) };
}
