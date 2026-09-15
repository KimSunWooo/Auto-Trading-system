import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { nowMs } from "@/src/clock";

export type WorkerLockRecord = {
  workerId: string;
  pid: number;
  lockedAt: number;
  heartbeatAt: number;
};

const DEFAULT_TTL_MS = 8_000;

let held: { workerId: string; filePath: string } | null = null;
let configuredLockPath: string | null = null;

export function defaultLockPath(): string {
  return configuredLockPath ?? path.join(process.cwd(), "data", "trading-worker.lock");
}

/** Test-only path injection. Unset in production so the worker lock file is unchanged. */
export function configureWorkerLockPath(filePath: string | null): void {
  configuredLockPath = filePath;
}

export function currentWorkerId(): string | null {
  return held?.workerId ?? null;
}

export function holdsWorkerLock(workerId?: string): boolean {
  if (!held) return false;
  if (workerId && held.workerId !== workerId) return false;
  const current = readLock(held.filePath);
  if (!current || current.workerId !== held.workerId) {
    held = null;
    return false;
  }
  return true;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(filePath: string): WorkerLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as WorkerLockRecord;
    if (!parsed?.workerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function payload(record: WorkerLockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function writeLock(filePath: string, record: WorkerLockRecord) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, payload(record), "utf8");
  writeFileSync(filePath, payload(record), "utf8");
  try {
    unlinkSync(tmp);
  } catch {
    // ignore
  }
}

function exclusiveCreate(filePath: string, record: WorkerLockRecord): boolean {
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      writeSync(fd, payload(record));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "EEXIST") return false;
    throw err;
  }
}

function stale(record: WorkerLockRecord, ttlMs: number, now: number): boolean {
  if (now - record.heartbeatAt > ttlMs) return true;
  if (!processAlive(record.pid)) return true;
  return false;
}

function confirmHeld(filePath: string, workerId: string): boolean {
  const confirmed = readLock(filePath);
  if (!confirmed || confirmed.workerId !== workerId) {
    if (held?.workerId === workerId) held = null;
    return false;
  }
  held = { workerId, filePath };
  return true;
}

export function tryAcquireWorkerLock(
  workerId: string,
  opts: { filePath?: string; ttlMs?: number } = {},
): boolean {
  const filePath = opts.filePath ?? defaultLockPath();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = nowMs();
  const existing = existsSync(filePath) ? readLock(filePath) : null;

  if (existing && existing.workerId === workerId) {
    writeLock(filePath, {
      ...existing,
      pid: process.pid,
      heartbeatAt: now,
    });
    return confirmHeld(filePath, workerId);
  }

  if (existing && !stale(existing, ttlMs, now)) {
    return false;
  }

  if (existing && stale(existing, ttlMs, now)) {
    try {
      unlinkSync(filePath);
    } catch {
      // another worker may have stolen it
    }
  }

  const record: WorkerLockRecord = {
    workerId,
    pid: process.pid,
    lockedAt: now,
    heartbeatAt: now,
  };

  if (!exclusiveCreate(filePath, record)) {
    const again = readLock(filePath);
    if (again?.workerId === workerId) {
      held = { workerId, filePath };
      return true;
    }
    return false;
  }
  return confirmHeld(filePath, workerId);
}

export function heartbeatWorkerLock(opts: { ttlMs?: number } = {}): boolean {
  if (!held) return false;
  const current = readLock(held.filePath);
  if (!current || current.workerId !== held.workerId) {
    held = null;
    return false;
  }
  return tryAcquireWorkerLock(held.workerId, { filePath: held.filePath, ttlMs: opts.ttlMs });
}

export function releaseWorkerLock(workerId?: string): void {
  if (!held) return;
  if (workerId && held.workerId !== workerId) return;
  const filePath = held.filePath;
  const current = readLock(filePath);
  held = null;
  if (current && workerId && current.workerId !== workerId) return;
  if (current && !workerId && current.pid !== process.pid) return;
  try {
    unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function resetWorkerLockForTest(): void {
  held = null;
  configuredLockPath = null;
}
