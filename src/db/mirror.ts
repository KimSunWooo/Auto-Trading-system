import type { AppState } from "@/lib/types";
import { dbConfigured, persistenceMode, type PersistenceMode } from "@/src/db/config";
import { persistTradingLedger } from "@/src/db/persist";
import { getMysqlLedger } from "@/src/db/mysql-ledger";
import type { MirrorContext } from "@/src/db/projector";
import {
  recordMirrorDegraded,
  snapshotDatabaseStatus,
  type DatabasePublicStatus,
} from "@/src/db/status";
import type { Ledger } from "@/src/db/ledger";
import type { EnvMap } from "@/src/runtime/trading-mode";
import { isNodeTestProcess } from "@/src/runtime/test-process";

let testLedger: Ledger | null = null;

/** Tests only. Production always uses MySQL when mode=mirror|database and DATABASE_URL is set. */
export function setMirrorLedgerForTest(ledger: Ledger | null): void {
  testLedger = ledger;
}

export async function resolveMirrorLedger(env: EnvMap = process.env): Promise<Ledger | null> {
  if (testLedger) return testLedger;
  // Unit/integration tests must never open the real RDS pool (keep-alive hang).
  // Explicit MemoryLedger via setMirrorLedgerForTest still works.
  if (isNodeTestProcess()) return null;
  if (!dbConfigured(env)) return null;
  return getMysqlLedger(env);
}

/**
 * After local AppState mutation:
 * - json: no DB write
 * - mirror: best-effort DB projection (never throws)
 * - database: required DB projection (throws DatabaseLedgerError)
 *
 * Broker retry stays 0 on failure — do not resubmit.
 */
export async function mirrorAfterJsonSave(
  state: AppState,
  env: EnvMap = process.env,
  context: MirrorContext = {},
): Promise<void> {
  await persistTradingLedger(state, env, context);
}

export function publicDatabaseStatus(env: EnvMap = process.env): DatabasePublicStatus {
  const mode: PersistenceMode = persistenceMode(env);
  const configured = dbConfigured(env) || testLedger != null;
  const enabled = (mode === "mirror" || mode === "database") && configured;
  return snapshotDatabaseStatus({
    enabled,
    mode,
  });
}

/** @deprecated use persistTradingLedger — kept for callers that recorded degrade only */
export function noteMirrorUnavailable(message: string): void {
  recordMirrorDegraded(message);
}
