/**
 * Worker lock — supports multiple account lock files in one process.
 * Bootstrap still uses data/trading-worker.lock; accounts use per-account paths.
 */
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

/** filePath → workerId currently held by this process */
const heldLocks = new Map<string, string>();
let configuredLockPath: string | null = null;

export function defaultLockPath(): string {
  return configuredLockPath ?? path.join(process.cwd(), "data", "trading-worker.lock");
}

/** Test-only path injection. Unset in production so the worker lock file is unchanged. */
export function configureWorkerLockPath(filePath: string | null): void {
  configuredLockPath = filePath;
}

export function currentWorkerId(): string | null {
  if (heldLocks.size === 0) return null;
  return heldLocks.values().next().value ?? null;
}

export function holdsWorkerLock(workerId?: string): boolean {
  if (heldLocks.size === 0) return false;
  for (const [filePath, wid] of [...heldLocks]) {
    const current = readLock(filePath);
    if (!current || current.workerId !== wid) {
      heldLocks.delete(filePath);
      continue;
    }
    if (!workerId || wid === workerId) return true;
  }
  return false;
}

/**
 * Dashboard / API isolates do not share in-memory heldLocks.
 * Treat the lock file heartbeat as the source of truth for "worker healthy".
 */
export function workerLockHealthy(opts: { filePath?: string; ttlMs?: number } = {}): boolean {
  if (opts.filePath) {
    if (heldLocks.has(opts.filePath) && holdsWorkerLock(heldLocks.get(opts.filePath))) {
      return true;
    }
  } else if (holdsWorkerLock()) {
    return true;
  }
  const filePath = opts.filePath ?? defaultLockPath();
  const current = existsSync(filePath) ? readLock(filePath) : null;
  if (!current) return false;
  return !stale(current, opts.ttlMs ?? DEFAULT_TTL_MS, nowMs());
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
    heldLocks.delete(filePath);
    return false;
  }
  heldLocks.set(filePath, workerId);
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
      heldLocks.set(filePath, workerId);
      return true;
    }
    return false;
  }
  return confirmHeld(filePath, workerId);
}

export function heartbeatWorkerLock(
  opts: { ttlMs?: number; filePath?: string; workerId?: string } = {},
): boolean {
  if (opts.filePath && opts.workerId) {
    const current = readLock(opts.filePath);
    if (!current || current.workerId !== opts.workerId) {
      heldLocks.delete(opts.filePath);
      return false;
    }
    return tryAcquireWorkerLock(opts.workerId, {
      filePath: opts.filePath,
      ttlMs: opts.ttlMs,
    });
  }
  if (heldLocks.size === 0) return false;
  let any = false;
  for (const [filePath, workerId] of [...heldLocks]) {
    const current = readLock(filePath);
    if (!current || current.workerId !== workerId) {
      heldLocks.delete(filePath);
      continue;
    }
    const ok = tryAcquireWorkerLock(workerId, { filePath, ttlMs: opts.ttlMs });
    if (ok) any = true;
  }
  return any;
}

export function releaseWorkerLock(workerId?: string, opts: { filePath?: string } = {}): void {
  if (opts.filePath) {
    const wid = heldLocks.get(opts.filePath);
    if (!wid) return;
    if (workerId && wid !== workerId) return;
    heldLocks.delete(opts.filePath);
    const current = readLock(opts.filePath);
    if (current && workerId && current.workerId !== workerId) return;
    if (current && !workerId && current.pid !== process.pid) return;
    try {
      unlinkSync(opts.filePath);
    } catch {
      // ignore
    }
    return;
  }

  if (heldLocks.size === 0) return;
  for (const [filePath, wid] of [...heldLocks]) {
    if (workerId && wid !== workerId) continue;
    heldLocks.delete(filePath);
    const current = readLock(filePath);
    if (current && workerId && current.workerId !== workerId) continue;
    if (current && !workerId && current.pid !== process.pid) continue;
    try {
      unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

export function resetWorkerLockForTest(): void {
  heldLocks.clear();
  configuredLockPath = null;
}
