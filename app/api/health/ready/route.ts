import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { accountDataDir } from "@/src/auth/paper-accounts";
import { getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { dbConfigured, isDatabaseLedgerAuthority, persistenceMode } from "@/src/db/config";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { allowLiveTrading, tradingMode } from "@/src/runtime/trading-mode";
import { workerLockHealthy } from "@/src/runtime/worker-lock";
import {
  listWorkerProgress,
  workerProgressPublic,
  WORKER_STALL_MS,
} from "@/src/runtime/worker-progress";

export const dynamic = "force-dynamic";

/**
 * Ready probe for PAPER soak.
 * Read-only: no KIS, no tick, no startup sync, no account client rebuild.
 * Account workers are judged by per-account progress + lock files — not bootstrap store.
 */
export async function GET() {
  const mode = tradingMode();
  const persist = persistenceMode();
  const broker = getBrokerPublicStatus();
  const db = publicDatabaseStatus();
  const dataDir = path.join(process.cwd(), "data");
  const jsonReadable = existsSync(dataDir);
  const now = Date.now();

  const workers = listWorkerProgress().map((row) => {
    const pub = workerProgressPublic(row, now);
    const accountId = row.accountId || resolveAccountId(row.accountIdPrefix);
    const lockPath = path.join(accountDataDir(accountId), "trading-worker.lock");
    const accountLockOk = workerLockHealthy({
      filePath: lockPath,
      ttlMs: WORKER_STALL_MS,
    });
    const processAlive = isProcessAlive(pub.pid);
    const sameProcess = pub.pid === process.pid;
    // File snapshots from a dead PID are observation residue — not current worker health.
    const observationStale = !processAlive;
    const stalled = observationStale ? true : pub.stalled;
    const stallReason = observationStale
      ? `stale observation pid=${pub.pid} (process not alive)`
      : pub.stallReason;
    return {
      accountIdPrefix: pub.accountIdPrefix,
      runId: pub.runId,
      tickId: pub.tickId,
      pid: pub.pid,
      sameProcess,
      processAlive,
      observationStale,
      stage: pub.stage,
      stageAgeMs: pub.stageAgeMs,
      tickStartedAt: pub.tickStartedAt,
      tickCompletedAt: pub.tickCompletedAt,
      lastPersistCompletedAt: pub.lastPersistCompletedAt,
      persistMs: pub.persistMs,
      tickMs: pub.tickMs,
      lastError: pub.lastError,
      stalled,
      persistFailed: pub.persistFailed,
      stallReason,
      lockHeartbeat: accountLockOk,
      // Heartbeat alone is not healthy — live process + tick/persist must advance.
      healthy:
        processAlive && accountLockOk && !stalled && !pub.persistFailed && !observationStale,
      // Distinct from "worker progressing" — orders require autoTrading + other gates.
      orderEligibleHint: "see authenticated account status; public ready never enables orders",
    };
  });

  const anyStalled = workers.some((w) => w.stalled || w.persistFailed);
  const anyHealthyWorker = workers.some((w) => w.healthy);
  const bootstrapLockOk = workerLockHealthy({ ttlMs: WORKER_STALL_MS });

  const rdsRequired =
    persist === "mirror" || persist === "database" || isDatabaseLedgerAuthority();
  const rdsOk =
    !rdsRequired || (dbConfigured() && db.enabled && !db.lastError && db.connected !== false);
  const realLocked = mode !== "live" && !allowLiveTrading();

  const workerOk =
    workers.length > 0
      ? anyHealthyWorker && !anyStalled
      : !["live_test", "live"].includes(mode) || bootstrapLockOk;

  const ready =
    jsonReadable &&
    workerOk &&
    realLocked &&
    (persist !== "database" || rdsOk) &&
    (persist !== "mirror" || rdsOk) &&
    !anyStalled;

  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      ready,
      checks: {
        jsonReadable,
        persistenceMode: persist,
        rds: rdsRequired ? (rdsOk ? "ok" : "degraded") : "n/a",
        rdsLastError: rdsRequired ? truncatePublic(db.lastError) : null,
        rdsLastMirrorAt: db.lastMirrorAt,
        brokerDriver: broker.driver,
        brokerConfigured: broker.configured,
        tradingMode: mode,
        realLocked,
        workerStallMs: WORKER_STALL_MS,
        bootstrapLockHeartbeat: bootstrapLockOk,
        accountWorkers: workers,
        anyStalled,
      },
    },
    { status: ready ? 200 : 503 },
  );
}

function truncatePublic(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 160);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveAccountId(prefix: string): string {
  const root = path.join(process.cwd(), "data", "accounts");
  if (!existsSync(root)) return prefix;
  try {
    for (const id of readdirSync(root)) {
      if (id.startsWith(prefix)) return id;
    }
  } catch {
    /* ignore */
  }
  return prefix;
}
