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
import type { RealtimeQuoteHub } from "@/src/market-data/kis-realtime-quote-hub";
import { dropQuoteHubRef } from "@/src/market-data/kis-realtime-registry";
import {
  acquirePaperQuoteHub,
  disposeScopeQuoteHub,
} from "@/src/market-data/ws-quote-feed";

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
  /** Process-local WS quote hub (AppKey-scoped; not serialized). One acquire per scope. */
  quoteHub: RealtimeQuoteHub | null;
};

const scopes = new Map<string, RuntimeScope>();
const startupDoneByAccount = new Map<string, boolean>();

/** Legacy owner PAPER testing path — preserved for existing soak/overseas regression. */
export function createBootstrapRuntimeScope(
  persistState: StatePersister,
): RuntimeScope {
  const brokerAccountId = "bootstrap-owner";
  const existing = scopes.get(brokerAccountId);
  if (existing) {
    scopes.delete(brokerAccountId);
    if (existing.quoteHub) {
      const hub = existing.quoteHub;
      existing.quoteHub = null;
      void hub.clearConsumerSubscriptions(existing.brokerAccountId).catch(() => undefined);
      void dropQuoteHubRef(hub);
    }
  }
  const kisClient = getSharedKisClient();
  const scope: RuntimeScope = {
    userId: null,
    brokerAccountId,
    environment: "BOOTSTRAP",
    statePath: path.join(process.cwd(), "data", "paper-account.json"),
    strategyPath: path.join(process.cwd(), "data", "strategy-config.json"),
    lockPath: path.join(process.cwd(), "data", "trading-worker.lock"),
    kisClient,
    persistState,
    startupSyncDone: startupDoneByAccount.get(brokerAccountId) === true,
    quoteHub: acquirePaperQuoteHub(kisClient),
  };
  scopes.set(brokerAccountId, scope);
  warnDuplicateKisAccountOwnership(scope);
  return scope;
}

export async function createAccountRuntimeScope(input: {
  userId: string;
  brokerAccountId: string;
  persistState: StatePersister;
}): Promise<RuntimeScope> {
  const existing = scopes.get(input.brokerAccountId);
  if (existing) {
    scopes.delete(input.brokerAccountId);
    if (existing.quoteHub) {
      await disposeScopeQuoteHub(existing.quoteHub, existing.brokerAccountId);
    }
  }
  const secret = await loadPaperSecretForAccount(input.brokerAccountId);
  if (!secret) throw new Error("PAPER credentials not found for account");
  const cfg = kisConfigFromPaperCredentials(secret);
  const dir = accountDataDir(input.brokerAccountId);
  const kisClient = new KisClient(cfg);
  const scope: RuntimeScope = {
    userId: input.userId,
    brokerAccountId: input.brokerAccountId,
    environment: "PAPER",
    statePath: path.join(dir, "state.json"),
    strategyPath: path.join(dir, "strategy-config.json"),
    lockPath: path.join(dir, "trading-worker.lock"),
    kisClient,
    persistState: input.persistState,
    startupSyncDone: startupDoneByAccount.get(input.brokerAccountId) === true,
    quoteHub: acquirePaperQuoteHub(kisClient),
  };
  scopes.set(input.brokerAccountId, scope);
  warnDuplicateKisAccountOwnership(scope);
  return scope;
}

/**
 * Bootstrap .env PAPER account + user-connected same KIS account must not both auto-trade.
 * Detection only — does not flatten or cancel orders.
 */
function warnDuplicateKisAccountOwnership(scope: RuntimeScope): void {
  if (!(scope.kisClient instanceof KisClient)) return;
  const cano = scope.kisClient.cano?.trim();
  if (!cano) return;
  for (const other of scopes.values()) {
    if (other.brokerAccountId === scope.brokerAccountId) continue;
    if (!(other.kisClient instanceof KisClient)) continue;
    if (other.kisClient.cano !== cano) continue;
    if (other.kisClient.mode !== "paper" || scope.kisClient.mode !== "paper") continue;
    console.warn(
      `[runtime-scope] DUPLICATE KIS PAPER account ownership detected: ` +
        `${scope.environment}:${scope.brokerAccountId} and ${other.environment}:${other.brokerAccountId} ` +
        `share the same CANO fingerprint — do not run autoTrading on both`,
    );
  }
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

/** Drop cached scope after credential rotate / account switch so KIS client rebuilds. */
export function invalidateRuntimeScope(brokerAccountId: string): void {
  const prev = scopes.get(brokerAccountId);
  scopes.delete(brokerAccountId);
  startupDoneByAccount.delete(brokerAccountId);
  if (prev?.quoteHub) {
    const hub = prev.quoteHub;
    const consumerId = prev.brokerAccountId;
    prev.quoteHub = null; // prevent double release of the same scope object
    // Consumer clear is best-effort async; registry ref drops synchronously.
    void hub.clearConsumerSubscriptions(consumerId).catch(() => undefined);
    void dropQuoteHubRef(hub);
  }
}

export function resetRuntimeScopesForTest(): void {
  const entries = [...scopes.values()];
  scopes.clear();
  startupDoneByAccount.clear();
  for (const scope of entries) {
    if (scope.quoteHub) {
      const hub = scope.quoteHub;
      const consumerId = scope.brokerAccountId;
      scope.quoteHub = null;
      void hub.clearConsumerSubscriptions(consumerId).catch(() => undefined);
      void dropQuoteHubRef(hub);
    }
  }
}
