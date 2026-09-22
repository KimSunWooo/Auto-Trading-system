/**
 * Resolve authenticated user → owned PAPER account → RuntimeScope + stores.
 * Never falls back to bootstrap owner for normal USER requests.
 */
import { and, eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { AuthError, requireUser } from "@/src/auth/guards";
import type { AuthUser } from "@/src/auth/session";
import { accountDataDir } from "@/src/auth/paper-accounts";
import {
  createAccountRuntimeScope,
  createBootstrapRuntimeScope,
  getRuntimeScope,
  type RuntimeScope,
} from "@/src/runtime/runtime-scope";
import {
  createTradingStateStore,
  type TradingStateStore,
} from "@/src/runtime/trading-state-store";
import {
  createRuleConfigStore,
  type RuleConfigStore,
} from "@/src/runtime/rule-config-store";
import { persistStateNow } from "@/lib/store";

export type ResolvedTradingRuntime = {
  user: AuthUser;
  account: typeof schema.brokerAccounts.$inferSelect;
  scope: RuntimeScope;
  store: TradingStateStore;
  rules: RuleConfigStore;
};

export class AccountNotConnectedError extends Error {
  readonly code = "ACCOUNT_NOT_CONNECTED";
  constructor(message = "PAPER broker account is not connected") {
    super(message);
    this.name = "AccountNotConnectedError";
  }
}

export async function findDefaultPaperAccount(userId: string) {
  const db = getDb();
  if (!db) throw new AuthError(503, "Database unavailable");
  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
        eq(schema.brokerAccounts.isDefault, true),
      ),
    )
    .limit(1);
  if (rows[0]) return rows[0];
  // Fallback: any ACTIVE PAPER for this user
  const any = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.userId, userId),
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
      ),
    )
    .limit(1);
  return any[0] ?? null;
}

async function buildScopeForAccount(
  user: AuthUser,
  account: typeof schema.brokerAccounts.$inferSelect,
): Promise<{ scope: RuntimeScope; store: TradingStateStore; rules: RuleConfigStore }> {
  const dir = accountDataDir(account.id);
  mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "state.json");
  const strategyPath = path.join(dir, "strategy-config.json");
  const store = createTradingStateStore({ statePath });
  const rules = createRuleConfigStore(strategyPath);

  let scope = getRuntimeScope(account.id);
  if (!scope || scope.userId !== user.id) {
    scope = await createAccountRuntimeScope({
      userId: user.id,
      brokerAccountId: account.id,
      persistState: (state) => store.persistStateNow(state),
    });
  } else {
    scope.persistState = (state) => store.persistStateNow(state);
  }
  return { scope, store, rules };
}

/** Authenticated USER path — never bootstrap fallback. */
export async function resolveCurrentTradingRuntime(): Promise<ResolvedTradingRuntime> {
  const user = await requireUser();
  const account = await findDefaultPaperAccount(user.id);
  if (!account) throw new AccountNotConnectedError();
  const { scope, store, rules } = await buildScopeForAccount(user, account);
  return { user, account, scope, store, rules };
}

/** Background worker path — resolve by owned ACTIVE PAPER account row (no session cookie). */
export async function resolveTradingRuntimeForAccount(
  account: typeof schema.brokerAccounts.$inferSelect,
): Promise<Omit<ResolvedTradingRuntime, "user"> & { userId: string }> {
  if (account.status !== "ACTIVE" || account.environment !== "PAPER") {
    throw new AccountNotConnectedError("Broker account is not an ACTIVE PAPER account");
  }
  const stubUser: AuthUser = {
    id: account.userId,
    email: "",
    displayName: "",
    role: "USER",
    status: "ACTIVE",
  };
  const { scope, store, rules } = await buildScopeForAccount(stubUser, account);
  return { userId: account.userId, account, scope, store, rules };
}

/** Explicit operator/bootstrap path only. */
export function resolveBootstrapTradingRuntime(): {
  scope: RuntimeScope;
  store: TradingStateStore;
  rules: RuleConfigStore;
} {
  const scope = createBootstrapRuntimeScope((state) => persistStateNow(state));
  const store = createTradingStateStore({
    statePath: scope.statePath,
    skipPersistUnderTest: true,
  });
  const rules = createRuleConfigStore(scope.strategyPath);
  return { scope, store, rules };
}

export function runtimeJsonError(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof AccountNotConnectedError) {
    return Response.json(
      { error: err.message, code: err.code },
      { status: 409 },
    );
  }
  return Response.json(
    { error: err instanceof Error ? err.message : "request failed" },
    { status: 500 },
  );
}
