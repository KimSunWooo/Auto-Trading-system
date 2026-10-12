/**
 * Ledger transaction timeouts, pool acquire bounds, and persist generation gates.
 * Never abandon SQL via Promise.race alone — destroy/release the connection.
 * Generation is scoped per broker account (or "bootstrap") so accounts do not
 * invalidate each other's in-flight persists.
 */
import type { Pool, PoolConnection } from "mysql2/promise";

/**
 * Tick projection over remote RDS measured ~22–23s for a small PAPER book
 * (≈12 orders) due to per-row round-trips. 20s caused permanent persist_failed.
 * Keep a bounded but realistic wait; still destroy on timeout (no abandoned SQL).
 */
export const LEDGER_TX_TIMEOUT_MS = 60_000;
export const LEDGER_ACQUIRE_TIMEOUT_MS = 5_000;

export type LedgerTxStage =
  | "db_acquire"
  | "tx_begin"
  | "project"
  | "commit"
  | "rollback"
  | "release";

export type LedgerTxOpts = {
  timeoutMs?: number;
  acquireTimeoutMs?: number;
  /** When false mid-flight, commit must not apply (generation superseded). */
  isCurrent?: () => boolean;
  onStage?: (stage: LedgerTxStage) => void;
};

export class LedgerTxTimeoutError extends Error {
  readonly code = "LEDGER_TX_TIMEOUT";
  constructor(message = "Ledger transaction exceeded wait limit") {
    super(message);
    this.name = "LedgerTxTimeoutError";
  }
}

export class LedgerPoolAcquireError extends Error {
  readonly code = "LEDGER_POOL_ACQUIRE_TIMEOUT";
  constructor(message = "Database pool acquire timed out") {
    super(message);
    this.name = "LedgerPoolAcquireError";
  }
}

export class LedgerTxStaleError extends Error {
  readonly code = "LEDGER_TX_STALE";
  constructor(message = "Ledger persist superseded before commit") {
    super(message);
    this.name = "LedgerTxStaleError";
  }
}

/** Commit may have landed on the server; caller must not assume success or safe retry. */
export class LedgerCommitUncertainError extends Error {
  readonly code = "LEDGER_COMMIT_UNCERTAIN";
  constructor(message = "Ledger commit outcome uncertain after timeout") {
    super(message);
    this.name = "LedgerCommitUncertainError";
  }
}

type GenGlobal = typeof globalThis & {
  __miraePersistGenerationByScope?: Map<string, number>;
};

function genSlot(): GenGlobal {
  return globalThis as GenGlobal;
}

function scopeMap(): Map<string, number> {
  const g = genSlot();
  g.__miraePersistGenerationByScope ??= new Map();
  return g.__miraePersistGenerationByScope;
}

export function persistScopeKey(brokerAccountId?: string | null): string {
  return brokerAccountId && brokerAccountId.length > 0 ? brokerAccountId : "bootstrap";
}

export function nextPersistGeneration(scopeKey = "bootstrap"): number {
  const map = scopeMap();
  const n = (map.get(scopeKey) ?? 0) + 1;
  map.set(scopeKey, n);
  return n;
}

export function persistGenerationIsCurrent(scopeKey: string, generation: number): boolean {
  return scopeMap().get(scopeKey) === generation;
}

export function resetPersistGenerationForTest(): void {
  genSlot().__miraePersistGenerationByScope = new Map();
}

export async function acquirePoolConnection(
  pool: Pool,
  timeoutMs = LEDGER_ACQUIRE_TIMEOUT_MS,
): Promise<PoolConnection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    const conn = await Promise.race([
      pool.getConnection().then((c) => {
        if (settled) {
          // Late winner after timeout — release immediately; never leave dangling.
          try {
            c.release();
          } catch {
            /* ignore */
          }
          throw new LedgerPoolAcquireError();
        }
        return c;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          settled = true;
          reject(new LedgerPoolAcquireError());
        }, timeoutMs);
      }),
    ]);
    settled = true;
    return conn;
  } catch (err) {
    settled = true;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
