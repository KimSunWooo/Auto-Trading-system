/**
 * Account-scoped background workers.
 * Bootstrap engine-loop remains for operator PAPER soak; this runner serves
 * authenticated USER ACTIVE PAPER accounts with isolated locks/stores/KIS.
 */
import { and, eq } from "drizzle-orm";
import path from "node:path";
import { HARD_LIMITS } from "@/src/risk/limits";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { accountDataDir } from "@/src/auth/paper-accounts";
import {
  heartbeatWorkerLock,
  releaseWorkerLock,
  tryAcquireWorkerLock,
} from "@/src/runtime/worker-lock";
import {
  emptyStartupSync,
  markProcessBootStartupVerified,
  runPaperStartupSync,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";
import {
  isScopeStartupSyncDone,
  markScopeStartupSyncDone,
} from "@/src/runtime/runtime-scope";
import { resolveTradingRuntimeForAccount } from "@/src/runtime/resolve-trading-runtime";
import { isNodeTestProcess } from "@/src/runtime/test-process";

const g = globalThis as typeof globalThis & {
  __accountEngine?: NodeJS.Timeout;
  __accountEngineShuttingDown?: boolean;
  __accountWorkerIds?: Map<string, string>;
  __accountStartupPromises?: Map<string, Promise<void>>;
  __accountStartupNextAttemptAt?: Map<string, number>;
};

function accountWorkerId(brokerAccountId: string): string {
  g.__accountWorkerIds ??= new Map();
  let id = g.__accountWorkerIds.get(brokerAccountId);
  if (!id) {
    id = `acct-${brokerAccountId.slice(0, 8)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
    g.__accountWorkerIds.set(brokerAccountId, id);
  }
  return id;
}

async function listActivePaperAccounts() {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
      ),
    );
}

async function ensureAccountStartupSync(
  brokerAccountId: string,
  store: Awaited<ReturnType<typeof resolveTradingRuntimeForAccount>>["store"],
  kisClient: Awaited<ReturnType<typeof resolveTradingRuntimeForAccount>>["scope"]["kisClient"],
): Promise<boolean> {
  if (!usesPaperStartupSync()) {
    markScopeStartupSyncDone(brokerAccountId, true);
    return true;
  }
  if (isScopeStartupSyncDone(brokerAccountId)) return true;

  g.__accountStartupPromises ??= new Map();
  const existing = g.__accountStartupPromises.get(brokerAccountId);
  if (existing) {
    await existing;
    return isScopeStartupSyncDone(brokerAccountId);
  }

  g.__accountStartupNextAttemptAt ??= new Map();
  const now = Date.now();
  if ((g.__accountStartupNextAttemptAt.get(brokerAccountId) ?? 0) > now) return false;

  const promise = (async () => {
    let healthy = false;
    let rateLimited = false;
    await store.mutateStore(async (state) => {
      const marked = {
        ...state,
        startupSync: {
          ...(state.startupSync ?? emptyStartupSync()),
          status: "SYNCING" as const,
          message: "Account process boot — fresh KIS PAPER Startup Sync",
        },
      };
      const result = await runPaperStartupSync(marked, kisClient);
      healthy = result.ok && result.state.startupSync?.status === "HEALTHY";
      const err = result.error ?? result.state.startupSync?.message ?? "";
      rateLimited = /초당|EGW00201|rate/i.test(err);
      if (!result.ok) {
        console.error(`[account-worker:${brokerAccountId}] startup sync FAILED:`, result.error);
      } else {
        console.info(
          `[account-worker:${brokerAccountId}] startup sync HEALTHY orphaned=${result.state.startupSync?.orphanedOrders ?? 0}`,
        );
      }
      return result.state;
    });
    if (healthy) {
      markScopeStartupSyncDone(brokerAccountId, true);
      g.__accountStartupNextAttemptAt?.delete(brokerAccountId);
    } else if (rateLimited) {
      g.__accountStartupNextAttemptAt?.set(brokerAccountId, Date.now() + 30_000);
    } else {
      g.__accountStartupNextAttemptAt?.set(brokerAccountId, Date.now() + 10_000);
    }
  })();

  g.__accountStartupPromises.set(brokerAccountId, promise);
  try {
    await promise;
  } finally {
    g.__accountStartupPromises.delete(brokerAccountId);
  }
  return isScopeStartupSyncDone(brokerAccountId);
}

/**
 * Auto-trading activation gate (Phase 22). Observation ticks may still run;
 * order path remains blocked by tickState / autoRunAllowed / startup sync.
 */
export function accountAutoTradingReady(input: {
  autoTradingEnabled: boolean;
  startupSyncHealthy: boolean;
  lockHeld: boolean;
  hasUnknown: boolean;
  reconciliationHealthy: boolean;
}): boolean {
  return (
    input.autoTradingEnabled &&
    input.startupSyncHealthy &&
    input.lockHeld &&
    !input.hasUnknown &&
    input.reconciliationHealthy
  );
}

async function tickOneAccount(
  account: typeof schema.brokerAccounts.$inferSelect,
): Promise<void> {
  if (g.__accountEngineShuttingDown) return;
  let rt: Awaited<ReturnType<typeof resolveTradingRuntimeForAccount>>;
  try {
    rt = await resolveTradingRuntimeForAccount(account);
  } catch (err) {
    console.error(
      `[account-worker:${account.id}] resolve failed:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const workerId = accountWorkerId(account.id);
  const locked =
    tryAcquireWorkerLock(workerId, { filePath: rt.scope.lockPath }) ||
    heartbeatWorkerLock({ filePath: rt.scope.lockPath, workerId });
  if (!locked) {
    console.error(`[account-worker:${account.id}] lock not acquired — skip tick`);
    return;
  }

  await ensureAccountStartupSync(account.id, rt.store, rt.scope.kisClient);

  const rules = rt.rules.get();
  await rt.store.tickAndGet(rules, {
    source: "worker",
    tickDeps: {
      kisClient: rt.scope.kisClient,
      persistState: rt.scope.persistState,
      ruleConfig: rules,
      forceBalanceSync: false,
      startupSyncVerified: isScopeStartupSyncDone(account.id),
      workerLockPath: rt.scope.lockPath,
      quoteHub: rt.scope.quoteHub,
      quoteConsumerId: rt.scope.brokerAccountId,
    },
  });
}

async function runAccountTicks(): Promise<void> {
  if (g.__accountEngineShuttingDown || isNodeTestProcess()) return;
  const accounts = await listActivePaperAccounts();
  for (const account of accounts) {
    try {
      await tickOneAccount(account);
    } catch (err) {
      console.error(
        `[account-worker:${account.id}]`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function startAccountEngineLoop(): void {
  if (g.__accountEngine || isNodeTestProcess()) return;
  g.__accountEngineShuttingDown = false;
  // Account scopes use per-account startup flags; do not bind bootstrap process flag.
  markProcessBootStartupVerified(false);
  void runAccountTicks().catch((err: unknown) => {
    console.error("[account-worker]", err instanceof Error ? err.message : err);
  });
  g.__accountEngine = setInterval(() => {
    void runAccountTicks().catch((err: unknown) => {
      console.error("[account-worker]", err instanceof Error ? err.message : err);
    });
  }, HARD_LIMITS.minTickMs);
}

export async function stopAccountEngineLoop(reason = "shutdown"): Promise<void> {
  if (g.__accountEngineShuttingDown) return;
  g.__accountEngineShuttingDown = true;
  console.info(`[account-worker] shutdown (${reason})`);
  if (g.__accountEngine) {
    clearInterval(g.__accountEngine);
    g.__accountEngine = undefined;
  }
  if (g.__accountWorkerIds) {
    for (const [accountId, workerId] of g.__accountWorkerIds) {
      const lockPath = path.join(accountDataDir(accountId), "trading-worker.lock");
      releaseWorkerLock(workerId, { filePath: lockPath });
    }
    g.__accountWorkerIds.clear();
  }
  const { resetQuoteHubRegistry } = await import("@/src/market-data/kis-realtime-registry");
  await resetQuoteHubRegistry();
}

export function stopAccountEngineLoopForTest(): void {
  if (g.__accountEngine) clearInterval(g.__accountEngine);
  g.__accountEngine = undefined;
  g.__accountEngineShuttingDown = false;
  g.__accountStartupPromises = new Map();
  g.__accountStartupNextAttemptAt = new Map();
  if (g.__accountWorkerIds) {
    for (const [, workerId] of g.__accountWorkerIds) {
      releaseWorkerLock(workerId);
    }
    g.__accountWorkerIds.clear();
  }
}

/** Test helper — tick a single resolved account without DB discovery. */
export async function tickAccountRuntimeForTest(
  account: typeof schema.brokerAccounts.$inferSelect,
): Promise<void> {
  await tickOneAccount(account);
}
