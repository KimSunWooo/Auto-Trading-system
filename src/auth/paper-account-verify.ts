/**
 * Strict read-only PAPER account verification before trading READY.
 * Never places orders. Never logs secrets or full account numbers.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import {
  decryptPaperCredentials,
  paperPhysicalAccountFingerprint,
} from "@/src/auth/crypto";
import { loadPaperSecretForAccount } from "@/src/auth/paper-accounts";
import {
  PaperAccountSelectionError,
  maybeSelfHealSinglePaperDefault,
  selectOwnedPaperAccount,
} from "@/src/auth/select-paper-account";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials, parseAccountNo } from "@/src/brokers/kis-config";
import { diffLocalVsKis } from "@/src/risk/balance-sync";
import { HARD_LIMITS } from "@/src/risk/limits";
import {
  getRuntimeScope,
  invalidateRuntimeScope,
  type RuntimeScope,
} from "@/src/runtime/runtime-scope";
import type { PaperAccountVerification } from "@/src/auth/paper-account-verification-types";
import type { AppState } from "@/lib/types";

export type { PaperAccountVerification };

function maskFromAccountNo(accountNo: string): string {
  const digits = accountNo.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `****${digits.slice(-4)}`;
}

async function loadEncryptedPayload(brokerAccountId: string) {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(schema.brokerSecretPayloads)
    .where(eq(schema.brokerSecretPayloads.brokerAccountId, brokerAccountId))
    .limit(1);
  return rows[0] ?? null;
}

function positionsExactMatch(
  state: AppState | null | undefined,
  holdings: Array<{ ticker: string; qty: number }>,
): boolean {
  if (!state) return false;
  const local = new Map<string, number>();
  for (const pos of state.positions) {
    if (pos.qty <= 0) continue;
    local.set(pos.code, (local.get(pos.code) ?? 0) + pos.qty);
  }
  const remote = new Map<string, number>();
  for (const h of holdings) {
    if (h.qty <= 0) continue;
    remote.set(h.ticker, (remote.get(h.ticker) ?? 0) + h.qty);
  }
  if (local.size !== remote.size) return false;
  for (const [ticker, qty] of remote) {
    if (local.get(ticker) !== qty) return false;
  }
  return true;
}

export async function verifyPaperAccountForUser(input: {
  userId: string;
  /** Optional local state for position compare (after startup sync). */
  state?: AppState | null;
  /** When true, skip live KIS (unit tests only). */
  skipLiveQuery?: boolean;
  /** Injected balance for tests. */
  mockBalance?: {
    cash: number;
    holdings: Array<{ ticker: string; name: string; qty: number; avgPrice: number }>;
    paginationComplete?: boolean;
    pagesFetched?: number;
    orderableCash?: number;
  };
}): Promise<PaperAccountVerification> {
  const blockers: string[] = [];
  const verifiedAt = new Date().toISOString();

  await maybeSelfHealSinglePaperDefault(input.userId);

  let account: Awaited<ReturnType<typeof selectOwnedPaperAccount>>;
  try {
    account = await selectOwnedPaperAccount(input.userId);
  } catch (err) {
    const code = err instanceof PaperAccountSelectionError ? err.code : "ACCOUNT_NOT_CONNECTED";
    blockers.push(code);
    return {
      brokerAccountId: "",
      environment: "PAPER",
      accountMasked: "****",
      bindingVerified: false,
      fingerprintVerified: false,
      runtimeClientVerified: false,
      freshBrokerQuery: false,
      paginationComplete: false,
      pagesFetched: 0,
      depositCash: 0,
      orderableCash: null,
      holdings: [],
      localPositionsMatched: false,
      verifiedAt,
      readyForTrading: false,
      blockers,
    };
  }

  if (account.userId !== input.userId) {
    blockers.push("ACCOUNT_OWNERSHIP_MISMATCH");
  }
  if (account.environment !== "PAPER") {
    blockers.push("ACCOUNT_NOT_PAPER");
  }
  if (account.status !== "ACTIVE") {
    blockers.push("ACCOUNT_NOT_ACTIVE");
  }

  const secret = await loadPaperSecretForAccount(account.id);
  if (!secret) {
    blockers.push("CREDENTIAL_MISSING");
  }

  let fingerprintVerified = false;
  let fingerprintPrefix: string | undefined;
  if (secret && account.physicalAccountFingerprint) {
    try {
      const computed = paperPhysicalAccountFingerprint(secret.accountNo);
      fingerprintVerified = computed === account.physicalAccountFingerprint;
      fingerprintPrefix = computed.slice(0, 8);
      if (!fingerprintVerified) {
        blockers.push("ACCOUNT_FINGERPRINT_MISMATCH");
        invalidateRuntimeScope(account.id);
      }
    } catch {
      blockers.push("ACCOUNT_FINGERPRINT_MISMATCH");
      invalidateRuntimeScope(account.id);
    }
  } else {
    blockers.push("ACCOUNT_FINGERPRINT_MISSING");
  }

  // Ensure encrypted payload decrypts to the same account as secret loader.
  const payload = await loadEncryptedPayload(account.id);
  if (payload && secret) {
    try {
      const roundtrip = decryptPaperCredentials({
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        authTag: payload.authTag,
      });
      if (
        paperPhysicalAccountFingerprint(roundtrip.accountNo) !==
        account.physicalAccountFingerprint
      ) {
        blockers.push("SECRET_DB_FINGERPRINT_MISMATCH");
      }
    } catch {
      blockers.push("SECRET_DECRYPT_FAILED");
    }
  }

  let runtimeClientVerified = false;
  const scope = getRuntimeScope(account.id);
  if (scope && secret) {
    runtimeClientVerified = verifyScopeMatchesSecret(scope, secret.accountNo);
    if (!runtimeClientVerified) {
      blockers.push("RUNTIME_SCOPE_ACCOUNT_MISMATCH");
      invalidateRuntimeScope(account.id);
    }
  }

  let freshBrokerQuery = false;
  let paginationComplete = false;
  let pagesFetched = 0;
  let depositCash = 0;
  let orderableCash: number | null = null;
  let holdings: PaperAccountVerification["holdings"] = [];

  if (input.mockBalance) {
    freshBrokerQuery = true;
    paginationComplete = input.mockBalance.paginationComplete !== false;
    pagesFetched = input.mockBalance.pagesFetched ?? 1;
    depositCash = input.mockBalance.cash;
    orderableCash = input.mockBalance.orderableCash ?? null;
    holdings = input.mockBalance.holdings.filter((h) => h.qty > 0);
    if (!paginationComplete) blockers.push("BALANCE_PAGINATION_INCOMPLETE");
  } else if (!input.skipLiveQuery && secret && blockers.length === 0) {
    try {
      const client = new KisClient(kisConfigFromPaperCredentials(secret));
      if (client.mode !== "paper") {
        blockers.push("KIS_CLIENT_NOT_PAPER");
      }
      const parsed = parseAccountNo(secret.accountNo);
      if (!parsed || client.cano !== parsed.cano || client.productCode !== parsed.productCode) {
        blockers.push("CANO_PRODUCT_MISMATCH");
      }
      const balance = await client.inquireBalance();
      freshBrokerQuery = true;
      paginationComplete = balance.paginationComplete !== false;
      pagesFetched = balance.pagesFetched ?? 1;
      depositCash = balance.cash;
      holdings = balance.holdings.filter((h) => h.qty > 0);
      if (!paginationComplete) {
        blockers.push("BALANCE_PAGINATION_INCOMPLETE");
      }
      // Preflight one-shot orderable cash (PAPER). Uses Samsung as PDNO reference only.
      try {
        const price = await client.inquirePrice("005930");
        const psbl = await client.inquirePsblOrder({
          ticker: "005930",
          price: Math.max(1, Math.round(price.price || 1)),
        });
        orderableCash = psbl.orderableCash;
      } catch {
        blockers.push("ORDERABLE_CASH_UNAVAILABLE");
      }
    } catch (err) {
      freshBrokerQuery = false;
      const msg = err instanceof Error ? err.message : "broker query failed";
      if (msg.includes("BALANCE_PAGINATION_INCOMPLETE")) {
        blockers.push("BALANCE_PAGINATION_INCOMPLETE");
      } else {
        blockers.push("BROKER_BALANCE_QUERY_FAILED");
      }
    }
  } else if (input.skipLiveQuery) {
    blockers.push("LIVE_QUERY_SKIPPED");
  }

  const localPositionsMatched =
    input.state != null
      ? positionsExactMatch(input.state, holdings)
      : false;
  if (input.state != null && !localPositionsMatched) {
    blockers.push("POSITION_QTY_MISMATCH");
  }

  // Optional: compare state.kisBalance.cash to fresh deposit when present.
  if (input.state?.kisBalance && freshBrokerQuery && paginationComplete) {
    if (input.state.kisBalance.cash !== depositCash) {
      blockers.push("KIS_BALANCE_CASH_MISMATCH");
    }
    if (
      orderableCash != null &&
      input.state.kisBalance.orderableCash != null &&
      input.state.kisBalance.orderableCash !== orderableCash
    ) {
      blockers.push("KIS_ORDERABLE_CASH_MISMATCH");
    }
  }

  const bindingVerified =
    blockers.filter((b) =>
      [
        "ACCOUNT_OWNERSHIP_MISMATCH",
        "ACCOUNT_NOT_PAPER",
        "ACCOUNT_NOT_ACTIVE",
        "CREDENTIAL_MISSING",
        "ACCOUNT_SELECTION_REQUIRED",
        "MULTIPLE_DEFAULT_ACCOUNTS",
        "ACCOUNT_NOT_CONNECTED",
      ].includes(b),
    ).length === 0;

  const readyForTrading =
    bindingVerified &&
    fingerprintVerified &&
    freshBrokerQuery &&
    paginationComplete &&
    (input.state == null || localPositionsMatched) &&
    orderableCash != null &&
    blockers.length === 0;

  return {
    brokerAccountId: account.id,
    environment: "PAPER",
    accountMasked: account.accountNumberMasked || (secret ? maskFromAccountNo(secret.accountNo) : "****"),
    bindingVerified,
    fingerprintVerified,
    runtimeClientVerified,
    freshBrokerQuery,
    paginationComplete,
    pagesFetched,
    depositCash,
    orderableCash,
    holdings,
    localPositionsMatched,
    verifiedAt,
    readyForTrading,
    blockers,
    fingerprintPrefix,
    strategyAllocatedCash: input.state?.cash,
  };
}

function verifyScopeMatchesSecret(scope: RuntimeScope, accountNo: string): boolean {
  if (scope.environment !== "PAPER") return false;
  if (!(scope.kisClient instanceof KisClient)) return false;
  if (scope.kisClient.mode !== "paper") return false;
  const parsed = parseAccountNo(accountNo);
  if (!parsed) return false;
  return scope.kisClient.cano === parsed.cano && scope.kisClient.productCode === parsed.productCode;
}

/** Exact qty compare helper for post-startup-sync recheck. */
export function exactHoldingsMatch(
  state: AppState,
  remote: { holdings: Array<{ ticker: string; qty: number }>; cash: number },
  env = process.env,
): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!positionsExactMatch(state, remote.holdings)) {
    reasons.push("POSITION_QTY_MISMATCH");
  }
  const diff = diffLocalVsKis(state, {
    cash: remote.cash,
    d2Cash: state.kisBalance?.d2Cash ?? remote.cash,
    holdings: remote.holdings.map((h) => ({
      ticker: h.ticker,
      name: h.ticker,
      qty: h.qty,
      avgPrice: 0,
    })),
  }, HARD_LIMITS.balanceCashToleranceKrw, env);
  // diff.matched also checks cash semantics — for exact qty we only care about positions here.
  return { matched: reasons.length === 0, reasons };
}
