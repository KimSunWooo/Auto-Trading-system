/**
 * Required DB ledger persistence for PERSISTENCE_MODE=database.
 * Failures must not be hidden by JSON fallback — callers must not submit
 * new broker orders when this throws.
 */
import type { AppState } from "@/lib/types";
import {
  dbConfigured,
  isDatabaseLedgerAuthority,
  persistenceMode,
} from "@/src/db/config";
import { resolveMirrorLedger } from "@/src/db/mirror";
import { projectAppState, type MirrorContext } from "@/src/db/projector";
import { recordMirrorDegraded, recordMirrorSuccess } from "@/src/db/status";
import type { EnvMap } from "@/src/runtime/trading-mode";

export class DatabaseLedgerError extends Error {
  readonly code = "DATABASE_LEDGER_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "DatabaseLedgerError";
  }
}

/**
 * Persist trading ledger to DB.
 * - database mode: required — throws DatabaseLedgerError on failure
 * - mirror mode: best-effort (never throws)
 * - json mode: no-op
 */
export async function persistTradingLedger(
  state: AppState,
  env: EnvMap = process.env,
  context: MirrorContext = {},
): Promise<void> {
  const mode = persistenceMode(env);
  if (mode === "json") return;

  const required = mode === "database";
  if (!dbConfigured(env) && required) {
    throw new DatabaseLedgerError("DATABASE_URL required for PERSISTENCE_MODE=database");
  }

  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    if (required) {
      throw new DatabaseLedgerError("Database ledger unavailable");
    }
    recordMirrorDegraded("DATABASE_URL missing");
    return;
  }

  try {
    await projectAppState(ledger, state, { ...context, env });
    recordMirrorSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : "ledger persist failed";
    recordMirrorDegraded(message);
    if (required) {
      throw new DatabaseLedgerError(message);
    }
  }
}

export function assertDatabaseLedgerReadyForOrders(env: EnvMap = process.env): string | null {
  if (!isDatabaseLedgerAuthority(env)) return null;
  if (!dbConfigured(env)) {
    return "PERSISTENCE_MODE=database but DATABASE_URL is not configured — 신규 주문 차단";
  }
  return null;
}
