/**
 * Lightweight RDS authority for execution flags + order blockers.
 * Used by Worker ticks so in-process dashboard cache cannot keep a stale ON
 * after another process commits OFF (or before an ON upsert commits).
 */
import type { AppState, CircuitState } from "@/lib/types";
import { emptyCircuit } from "@/src/risk/circuit";
import { resolveMirrorLedger } from "@/src/db/mirror";
import { isDatabaseLedgerAuthority } from "@/src/db/config";
import type { EnvMap } from "@/src/runtime/trading-mode";

export type ExecutionAuthority = {
  source: "rds" | "unavailable" | "skipped";
  autoTrading: boolean | null;
  liquidating: boolean | null;
  onboardingComplete: boolean | null;
  circuit: CircuitState | null;
  /** Active unknown / pending-without-ODNO parents (blocking). */
  hasUnresolvedOrderRisk: boolean | null;
  error?: string;
};

export async function readExecutionAuthorityFromRds(
  brokerAccountId: string,
  env: EnvMap = process.env,
): Promise<ExecutionAuthority> {
  if (!isDatabaseLedgerAuthority(env)) {
    return {
      source: "skipped",
      autoTrading: null,
      liquidating: null,
      onboardingComplete: null,
      circuit: null,
      hasUnresolvedOrderRisk: null,
    };
  }
  try {
    const ledger = await resolveMirrorLedger(env);
    if (!ledger) {
      return {
        source: "unavailable",
        autoTrading: null,
        liquidating: null,
        onboardingComplete: null,
        circuit: null,
        hasUnresolvedOrderRisk: null,
        error: "RDS ledger unavailable",
      };
    }
    return await ledger.transaction(async (tx) => {
      const [row, hasUnresolvedOrderRisk] = await Promise.all([
        tx.getTradingAccountState(brokerAccountId),
        tx.hasBlockingOpenOrders(brokerAccountId),
      ]);
      if (!row) {
        return {
          source: "rds" as const,
          autoTrading: false,
          liquidating: false,
          onboardingComplete: false,
          circuit: emptyCircuit(),
          hasUnresolvedOrderRisk,
        };
      }
      const circuit: CircuitState = row.circuitHalted
        ? {
            halted: true,
            kind: (row.circuitKind as CircuitState["kind"]) ?? undefined,
            reason: row.circuitReason ?? "RDS circuit",
            unknownCount: row.unknownOrderCount ?? 0,
          }
        : {
            halted: false,
            unknownCount: row.unknownOrderCount ?? 0,
            kind: undefined,
            reason: undefined,
          };
      return {
        source: "rds" as const,
        autoTrading: Boolean(row.autoTradingEnabled),
        liquidating: Boolean(row.liquidating),
        onboardingComplete: Boolean(row.onboardingComplete),
        circuit,
        hasUnresolvedOrderRisk,
      };
    });
  } catch (err) {
    return {
      source: "unavailable",
      autoTrading: null,
      liquidating: null,
      onboardingComplete: null,
      circuit: null,
      hasUnresolvedOrderRisk: null,
      error: err instanceof Error ? err.message : "RDS authority read failed",
    };
  }
}

/** Merge committed RDS flags into a cached AppState (quotes/book otherwise kept). */
export function applyExecutionAuthority(
  state: AppState,
  authority: ExecutionAuthority,
): AppState {
  if (authority.source !== "rds") return state;
  return {
    ...state,
    settings: {
      ...state.settings,
      autoTrading: Boolean(authority.autoTrading),
      liquidating: Boolean(authority.liquidating),
      onboardingComplete:
        authority.onboardingComplete == null
          ? state.settings.onboardingComplete
          : Boolean(authority.onboardingComplete),
    },
    circuit: authority.circuit
      ? {
          ...state.circuit,
          ...authority.circuit,
          // Preserve openedAt if already halted locally with same kind.
          openedAt: authority.circuit.halted
            ? (state.circuit.openedAt ?? new Date().toISOString())
            : undefined,
        }
      : state.circuit,
  };
}

export function executionAuthorityBlocksTrading(authority: ExecutionAuthority): string | null {
  if (authority.source === "unavailable") {
    return (
      authority.error ??
      "RDS 실행 설정을 확인할 수 없어 신규 주문을 차단합니다."
    );
  }
  if (authority.source === "rds" && authority.hasUnresolvedOrderRisk) {
    return "RDS에 미확인·미완료 주문이 있어 신규 주문을 차단합니다.";
  }
  return null;
}
