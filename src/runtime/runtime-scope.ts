/**
 * Per-broker-account runtime scope.
 * Wraps existing trading core without rewriting OrderManager / RuleRunner.
 */
import path from "node:path";
import type { AppState } from "@/lib/types";
import type { KisApi } from "@/src/brokers/kis-client";
import { KisClient, getSharedKisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";
import { accountDataDir, loadPaperSecretForAccount } from "@/src/auth/paper-accounts";

export type StatePersister = (state: AppState) => Promise<void>;

export type RuntimeScope = {
  userId: string | null;
  brokerAccountId: string;
  environment: "PAPER" | "BOOTSTRAP";
  statePath: string;
  strategyPath: string;
  lockPath: string;
  kisClient: KisApi;
  persistState: StatePersister;
  /** Process-local: this scope completed fresh startup sync in THIS process. */
  startupSyncDone: boolean;
};

const scopes = new Map<string, RuntimeScope>();
const startupDoneByAccount = new Map<string, boolean>();

/** Legacy owner PAPER testing path — preserved for existing soak/overseas regression. */
export function createBootstrapRuntimeScope(
  persistState: StatePersister,
): RuntimeScope {
  const brokerAccountId = "bootstrap-owner";
  const scope: RuntimeScope = {
    userId: null,
    brokerAccountId,
    environment: "BOOTSTRAP",
    statePath: path.join(process.cwd(), "data", "paper-account.json"),
    strategyPath: path.join(process.cwd(), "data", "strategy-config.json"),
    lockPath: path.join(process.cwd(), "data", "trading-worker.lock"),
    kisClient: getSharedKisClient(),
    persistState,
    startupSyncDone: startupDoneByAccount.get(brokerAccountId) === true,
  };
  scopes.set(brokerAccountId, scope);
  return scope;
}

export async function createAccountRuntimeScope(input: {
  userId: string;
  brokerAccountId: string;
  persistState: StatePersister;
}): Promise<RuntimeScope> {
  const secret = await loadPaperSecretForAccount(input.brokerAccountId);
  if (!secret) throw new Error("PAPER credentials not found for account");
  const cfg = kisConfigFromPaperCredentials(secret);
  const dir = accountDataDir(input.brokerAccountId);
  const scope: RuntimeScope = {
    userId: input.userId,
    brokerAccountId: input.brokerAccountId,
    environment: "PAPER",
    statePath: path.join(dir, "state.json"),
    strategyPath: path.join(dir, "strategy-config.json"),
    lockPath: path.join(dir, "trading-worker.lock"),
    kisClient: new KisClient(cfg),
    persistState: input.persistState,
    startupSyncDone: startupDoneByAccount.get(input.brokerAccountId) === true,
  };
  scopes.set(input.brokerAccountId, scope);
  return scope;
}

export function markScopeStartupSyncDone(brokerAccountId: string, done = true): void {
  startupDoneByAccount.set(brokerAccountId, done);
  const scope = scopes.get(brokerAccountId);
  if (scope) scope.startupSyncDone = done;
}

export function isScopeStartupSyncDone(brokerAccountId: string): boolean {
  return startupDoneByAccount.get(brokerAccountId) === true;
}

export function getRuntimeScope(brokerAccountId: string): RuntimeScope | undefined {
  return scopes.get(brokerAccountId);
}

export function resetRuntimeScopesForTest(): void {
  scopes.clear();
  startupDoneByAccount.clear();
}
