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
import {
  recordMirrorDegraded,
  recordMirrorSuccess,
  snapshotDatabaseStatus,
} from "@/src/db/status";
import type { EnvMap } from "@/src/runtime/trading-mode";
import {
  LEDGER_TX_TIMEOUT_MS,
  LedgerCommitUncertainError,
  nextPersistGeneration,
  persistGenerationIsCurrent,
  persistScopeKey,
} from "@/src/db/ledger-tx";

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

  const scope = persistScopeKey(context.brokerAccountId);
  try {
    const generation = nextPersistGeneration(scope);
    await projectAppState(ledger, state, {
      ...context,
      env,
      projectMode: context.projectMode ?? "full",
      txOpts: {
        timeoutMs: context.txOpts?.timeoutMs ?? LEDGER_TX_TIMEOUT_MS,
        isCurrent: () => persistGenerationIsCurrent(scope, generation),
        onStage: context.txOpts?.onStage,
      },
    });
    if (!persistGenerationIsCurrent(scope, generation)) {
      throw new DatabaseLedgerError("Ledger persist superseded before completion");
    }
    recordMirrorSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : "ledger persist failed";
    if (err instanceof LedgerCommitUncertainError) {
      recordMirrorDegraded(`LEDGER_COMMIT_UNCERTAIN: ${message}`);
    } else {
      recordMirrorDegraded(message);
    }
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
  const dbStatus = snapshotDatabaseStatus({
    enabled: true,
    mode: "database",
  });
  if (dbStatus.lastError) {
    return "DB ledger degraded — 신규 주문 차단";
  }
  return null;
}

/**
 * Fast path for Settings PATCH — upsert only trading_account_state execution flags.
 * Avoids full projectAppState which can stall behind a concurrent worker tick.
 */
export async function persistUserExecutionSettingsFlags(
  state: AppState,
  brokerAccountId: string,
  env: EnvMap = process.env,
): Promise<void> {
  if (!dbConfigured(env)) {
    throw new DatabaseLedgerError("DATABASE_URL required for settings persist");
  }
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    throw new DatabaseLedgerError("Database ledger unavailable for settings persist");
  }
  const scope = persistScopeKey(brokerAccountId);
  try {
    // Bump account generation so an in-flight tick cannot commit stale ON over OFF.
    const generation = nextPersistGeneration(scope);
    await ledger.transaction(
      async (tx) => {
        if (!persistGenerationIsCurrent(scope, generation)) {
          throw new DatabaseLedgerError("Settings persist superseded before write");
        }
        const prev = await tx.getTradingAccountState(brokerAccountId);
        await tx.upsertTradingAccountState({
          brokerAccountId,
          autoTradingEnabled: Boolean(state.settings.autoTrading),
          onboardingComplete: Boolean(state.settings.onboardingComplete),
          liquidating: Boolean(state.settings.liquidating),
          circuitHalted: prev?.circuitHalted ?? Boolean(state.circuit.halted),
          circuitKind: prev?.circuitKind ?? state.circuit.kind ?? null,
          circuitReason: prev?.circuitReason ?? state.circuit.reason ?? null,
          unknownOrderCount: prev?.unknownOrderCount ?? state.circuit.unknownCount ?? 0,
          lastBalanceSyncAt: prev?.lastBalanceSyncAt ?? null,
          lastEngineAt: prev?.lastEngineAt ?? null,
          lastOrderAt: prev?.lastOrderAt ?? null,
        });
      },
      {
        timeoutMs: LEDGER_TX_TIMEOUT_MS,
        isCurrent: () => persistGenerationIsCurrent(scope, generation),
      },
    );
    if (!persistGenerationIsCurrent(scope, generation)) {
      throw new DatabaseLedgerError("Settings persist superseded before completion");
    }
    recordMirrorSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : "settings flag persist failed";
    if (err instanceof LedgerCommitUncertainError) {
      recordMirrorDegraded(`LEDGER_COMMIT_UNCERTAIN: ${message}`);
    } else {
      recordMirrorDegraded(message);
    }
    throw new DatabaseLedgerError(message);
  }
}
