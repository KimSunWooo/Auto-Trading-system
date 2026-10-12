/**
 * Process-local worker progress for readiness (no KIS, no tick trigger).
 * Stored on globalThis so Next instrumentation and route bundles share it,
 * and mirrored to the account data dir for same-host file fallback.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { accountDataDir } from "@/src/auth/paper-accounts";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import { nowMs } from "@/src/clock";

export const WORKER_STALL_MS = 45_000;

export type WorkerProgressStage =
  | "idle"
  | "queue_enter"
  | "tick_start"
  | "persist_start"
  | "db_acquire"
  | "tx_begin"
  | "project"
  | "commit"
  | "persist_done"
  | "tick_done"
  | "persist_failed"
  | "tick_failed";

export type WorkerProgress = {
  runId: string;
  tickId: string;
  /** Full broker account id (observation only — not ledger SoT). */
  accountId: string;
  accountIdPrefix: string;
  pid: number;
  stage: WorkerProgressStage;
  stageAt: number;
  tickStartedAt: number | null;
  tickCompletedAt: number | null;
  lastPersistCompletedAt: number | null;
  lastError: string | null;
  persistMs: number | null;
  tickMs: number | null;
};

type ProgressGlobal = typeof globalThis & {
  __miraeWorkerRunId?: string;
  __miraeWorkerProgress?: Map<string, WorkerProgress>;
};

function slot(): ProgressGlobal {
  return globalThis as ProgressGlobal;
}

function accountPrefix(accountId: string): string {
  return String(accountId ?? "").slice(0, 8);
}

export function workerRunId(): string {
  const g = slot();
  if (!g.__miraeWorkerRunId) {
    g.__miraeWorkerRunId = `run-${process.pid}-${nowMs().toString(36)}`;
  }
  return g.__miraeWorkerRunId;
}

export function nextTickId(accountId: string): string {
  return `t-${accountPrefix(accountId)}-${nowMs().toString(36)}`;
}

function progressMap(): Map<string, WorkerProgress> {
  const g = slot();
  g.__miraeWorkerProgress ??= new Map();
  return g.__miraeWorkerProgress;
}

function progressPath(accountId: string): string {
  return path.join(accountDataDir(accountId), "worker-progress.json");
}

export function recordWorkerProgress(
  accountId: string,
  patch: Partial<WorkerProgress> & { stage: WorkerProgressStage; tickId: string },
): WorkerProgress {
  const now = nowMs();
  const prev = progressMap().get(accountId);
  const next: WorkerProgress = {
    runId: workerRunId(),
    tickId: patch.tickId,
    accountId,
    accountIdPrefix: accountPrefix(accountId),
    pid: process.pid,
    stage: patch.stage,
    stageAt: now,
    tickStartedAt: patch.tickStartedAt ?? prev?.tickStartedAt ?? null,
    tickCompletedAt: patch.tickCompletedAt ?? prev?.tickCompletedAt ?? null,
    lastPersistCompletedAt: patch.lastPersistCompletedAt ?? prev?.lastPersistCompletedAt ?? null,
    lastError: patch.lastError === undefined ? (prev?.lastError ?? null) : patch.lastError,
    persistMs: patch.persistMs ?? prev?.persistMs ?? null,
    tickMs: patch.tickMs ?? prev?.tickMs ?? null,
    ...("runId" in patch && patch.runId ? { runId: patch.runId } : {}),
  };
  if (patch.stage === "tick_start") {
    next.tickStartedAt = now;
    next.tickCompletedAt = null;
    next.lastError = null;
    next.tickMs = null;
    next.persistMs = null;
  }
  if (patch.stage === "tick_done") {
    next.tickCompletedAt = now;
    next.tickMs = next.tickStartedAt ? now - next.tickStartedAt : null;
  }
  if (patch.stage === "persist_done") {
    next.lastPersistCompletedAt = now;
  }
  progressMap().set(accountId, next);
  if (!isNodeTestProcess()) {
    try {
      const dir = accountDataDir(accountId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(progressPath(accountId), `${JSON.stringify(next)}\n`);
    } catch {
      /* observation file is best-effort */
    }
  }
  return next;
}

export function getWorkerProgress(accountId: string): WorkerProgress | undefined {
  return progressMap().get(accountId);
}

export function resetWorkerProgressForTest(): void {
  progressMap().clear();
  delete slot().__miraeWorkerRunId;
}

export type WorkerProgressPublic = WorkerProgress & {
  stalled: boolean;
  persistFailed: boolean;
  stallReason: string | null;
  stageAgeMs: number;
};

export function workerProgressPublic(
  row: WorkerProgress,
  now = nowMs(),
): WorkerProgressPublic {
  const stageAgeMs = Math.max(0, now - row.stageAt);
  const inFlight =
    row.stage !== "tick_done" &&
    row.stage !== "idle" &&
    row.stage !== "persist_failed" &&
    row.stage !== "tick_failed";
  const stalled = inFlight && stageAgeMs >= WORKER_STALL_MS;
  const persistFailed = row.stage === "persist_failed";
  let stallReason: string | null = null;
  if (persistFailed) stallReason = `persist_failed: ${row.lastError ?? "unknown"}`;
  else if (stalled) stallReason = `stalled at ${row.stage} for ${stageAgeMs}ms`;
  return { ...row, stalled, persistFailed, stallReason, stageAgeMs };
}

function readProgressFile(accountId: string): WorkerProgress | null {
  try {
    const raw = readFileSync(progressPath(accountId), "utf8");
    const parsed = JSON.parse(raw) as WorkerProgress;
    if (!parsed?.tickId || !parsed?.stage) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listWorkerProgress(dataRoot?: string): WorkerProgress[] {
  const mem = [...progressMap().entries()];
  const byId = new Map<string, WorkerProgress>();
  for (const [id, row] of mem) {
    byId.set(id, { ...row, accountId: row.accountId || id });
  }
  const root = dataRoot
    ? path.join(dataRoot, "accounts")
    : path.join(process.cwd(), "data", "accounts");
  if (existsSync(root)) {
    try {
      for (const id of readdirSync(root)) {
        if (id.startsWith(".") || byId.has(id)) continue;
        const file = readProgressFile(id);
        if (file) byId.set(id, { ...file, accountId: file.accountId || id });
      }
    } catch {
      /* ignore */
    }
  }
  return [...byId.values()];
}
