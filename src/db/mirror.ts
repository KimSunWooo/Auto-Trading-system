import type { AppState } from "@/lib/types";
import { dbConfigured, persistenceMode, type PersistenceMode } from "@/src/db/config";
import { getMysqlLedger } from "@/src/db/mysql-ledger";
import { projectAppState, type MirrorContext } from "@/src/db/projector";
import {
  recordMirrorDegraded,
  recordMirrorSuccess,
  snapshotDatabaseStatus,
  type DatabasePublicStatus,
} from "@/src/db/status";
import type { Ledger } from "@/src/db/ledger";
import type { EnvMap } from "@/src/runtime/trading-mode";
import { isNodeTestProcess } from "@/src/runtime/test-process";

let testLedger: Ledger | null = null;

/** Tests only. Production always uses MySQL when mode=mirror and DATABASE_URL is set. */
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
 * JSON save has already succeeded. Mirror is best-effort.
 * Failures record DB_MIRROR_DEGRADED and never throw — broker retry stays 0.
 */
export async function mirrorAfterJsonSave(
  state: AppState,
  env: EnvMap = process.env,
  context: MirrorContext = {},
): Promise<void> {
  const mode = persistenceMode(env);
  if (mode !== "mirror") return;
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    recordMirrorDegraded("DATABASE_URL missing");
    return;
  }
  try {
    await projectAppState(ledger, state, { ...context, env });
    recordMirrorSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : "mirror failed";
    recordMirrorDegraded(message);
  }
}

export function publicDatabaseStatus(env: EnvMap = process.env): DatabasePublicStatus {
  const mode: PersistenceMode = persistenceMode(env);
  const configured = dbConfigured(env) || testLedger != null;
  return snapshotDatabaseStatus({
    enabled: mode === "mirror" && configured,
    mode,
  });
}
