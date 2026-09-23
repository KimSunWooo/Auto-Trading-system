/**
 * Resolve authenticated user → owned PAPER account → RuntimeScope + stores.
 * Never falls back to bootstrap owner for normal USER requests.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import { AuthError, requireUser } from "@/src/auth/guards";
import type { AuthUser } from "@/src/auth/session";
import { accountDataDir } from "@/src/auth/paper-accounts";
import {
  findDefaultPaperAccount,
  PaperAccountSelectionError,
} from "@/src/auth/select-paper-account";
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

export { findDefaultPaperAccount, PaperAccountSelectionError };

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
  try {
    const account = await findDefaultPaperAccount(user.id);
    if (!account) throw new AccountNotConnectedError();
    const { scope, store, rules } = await buildScopeForAccount(user, account);
    return { user, account, scope, store, rules };
  } catch (err) {
    if (err instanceof PaperAccountSelectionError) {
      if (err.code === "ACCOUNT_NOT_CONNECTED") throw new AccountNotConnectedError(err.message);
      throw err;
    }
    throw err;
  }
}

/** Background worker path — resolve by owned ACTIVE PAPER account row (no session cookie). */
export async function resolveTradingRuntimeForAccount(
  account: typeof schema.brokerAccounts.$inferSelect,
): Promise<Omit<ResolvedTradingRuntime, "user"> & { userId: string }> {
  if (account.status !== "ACTIVE" || account.environment !== "PAPER") {
    throw new AccountNotConnectedError("Broker account is not an ACTIVE PAPER account");
  }
  if (!account.physicalAccountFingerprint) {
    throw new AccountNotConnectedError("ACTIVE PAPER account missing physical fingerprint");
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
  if (err instanceof PaperAccountSelectionError) {
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
