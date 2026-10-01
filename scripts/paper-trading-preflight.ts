/**
 * PAPER auto-trading preflight + Startup Sync (inquiries only).
 * Uses the same PaperTradingPreflightService as Settings API.
 * Never enables autoTrading. Never places BUY/SELL/CANCEL. Never REAL.
 *
 * Usage: npx tsx scripts/paper-trading-preflight.ts
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

process.env.ALLOW_LIVE_TRADING = "false";
process.env.KIS_MODE = String(process.env.KIS_MODE ?? "paper").trim() || "paper";
process.env.TRADING_MODE = String(process.env.TRADING_MODE ?? "live_test").trim() || "live_test";
process.env.BROKER = String(process.env.BROKER ?? "kis").trim() || "kis";
delete process.env.KIS_LIVE_CONFIRM;
delete process.env.KIS_REAL_APP_KEY;
delete process.env.KIS_REAL_APP_SECRET;
delete process.env.KIS_REAL_ACCOUNT_NO;

const TARGET = "e3152ebd-c8f5-432f-8923-287d3163e79c";
const EXPECT_USER = "ff8b3224-5330-46b2-a7a4-481791a4824f";

async function main() {
  if (String(process.env.ALLOW_LIVE_TRADING).toLowerCase() === "true") {
    throw new Error("ABORT: ALLOW_LIVE_TRADING=true");
  }
  if (String(process.env.KIS_MODE).toLowerCase() === "real") {
    throw new Error("ABORT: KIS_MODE=real");
  }
  if (String(process.env.TRADING_MODE).toLowerCase() === "live") {
    throw new Error("ABORT: TRADING_MODE=live");
  }

  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("@/src/db/client");
  const schema = await import("@/src/db/schema");
  const { resolveTradingRuntimeForAccount } = await import(
    "@/src/runtime/resolve-trading-runtime"
  );
  const { invalidateRuntimeScope, markScopeStartupSyncDone } = await import(
    "@/src/runtime/runtime-scope"
  );
  const { usesPaperStartupSync, findActiveUnknownOrder } = await import(
    "@/src/runtime/startup-sync"
  );
  const {
    tryAcquireWorkerLock,
    releaseWorkerLock,
    workerLockHealthy,
  } = await import("@/src/runtime/worker-lock");
  const { runPaperTradingPreflightService } = await import(
    "@/src/runtime/paper-trading-preflight"
  );
  const { loadPaperSecretForAccount } = await import("@/src/auth/paper-accounts");
  const { maskAccountNumber, paperPhysicalAccountFingerprint } = await import(
    "@/src/auth/crypto"
  );

  console.log("=== PAPER Trading Preflight ===");
  console.log("BROKER=", process.env.BROKER);
  console.log("KIS_MODE=", process.env.KIS_MODE);
  console.log("TRADING_MODE=", process.env.TRADING_MODE);
  console.log("ALLOW_LIVE_TRADING=", process.env.ALLOW_LIVE_TRADING);
  console.log("usesPaperStartupSync=", usesPaperStartupSync() ? "YES" : "NO");
  console.log("sharedService=", "PaperTradingPreflightService");

  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const account = (
    await db
      .select()
      .from(schema.brokerAccounts)
      .where(eq(schema.brokerAccounts.id, TARGET))
      .limit(1)
  )[0];
  if (!account) throw new Error("TARGET account not found");
  if (account.userId !== EXPECT_USER) throw new Error("userId mismatch — abort");
  if (account.environment !== "PAPER" || account.status !== "ACTIVE") {
    throw new Error(`account not ACTIVE PAPER (${account.environment}/${account.status})`);
  }
  console.log("account.id=", account.id);
  console.log("account.userId.match=", account.userId === EXPECT_USER ? "YES" : "NO");
  console.log("account.masked=", account.accountNumberMasked);
  console.log("account.status=", account.status);

  const secret = await loadPaperSecretForAccount(account.id);
  if (!secret) throw new Error("credential missing");
  const fp = paperPhysicalAccountFingerprint(secret.accountNo);
  console.log("credential.decrypt=", "OK");
  console.log("fingerprint.match=", fp === account.physicalAccountFingerprint ? "YES" : "NO");
  console.log(
    "masked.match=",
    maskAccountNumber(secret.accountNo) === account.accountNumberMasked ? "YES" : "NO",
  );

  invalidateRuntimeScope(account.id);
  markScopeStartupSyncDone(account.id, false);

  const rt = await resolveTradingRuntimeForAccount(account);
  console.log("runtime.resolve=", "OK");
  console.log("kisClient.mode=", (rt.scope.kisClient as { mode?: string }).mode);

  const workerId = `preflight-${process.pid}`;
  const locked = tryAcquireWorkerLock(workerId, { filePath: rt.scope.lockPath });
  console.log("workerLock.acquire=", locked ? "YES" : "NO");
  if (!locked) {
    throw new Error("Could not acquire worker lock — stop other workers and retry");
  }

  const stateBefore = await rt.store.getState();
  const evaluated = await runPaperTradingPreflightService({
    userId: account.userId,
    brokerAccountId: account.id,
    state: stateBefore,
    workerLockPath: rt.scope.lockPath,
    kisClient: rt.scope.kisClient,
    mutateStore: (fn) => rt.store.mutateStore(fn),
    refreshIfNeeded: true,
    probeKisAuth: true,
  });

  const state = await rt.store.getState();
  console.log("startupSync.status=", evaluated.details.startupSyncStatus ?? state.startupSync?.status);
  console.log("openOrders.local=", state.orders.filter((o) => o.status === "pending").length);
  console.log("unknown.active=", findActiveUnknownOrder(state) ? "YES" : "NO");
  console.log("positions.local=", state.positions.filter((p) => p.qty > 0).length);
  console.log("kis.holdings=", state.kisBalance?.holdings?.length ?? 0);
  console.log("kis.deposit=", state.kisBalance?.cash ?? null);
  console.log("kis.orderable=", state.kisBalance?.orderableCash ?? null);
  console.log("kis.matched=", state.kisBalance?.matched ?? null);
  console.log("recon=", state.safety?.reconciliation ?? "(unset)");
  console.log("autoTrading=", state.settings.autoTrading ? "ON" : "OFF");
  console.log("workerLock.healthy=", workerLockHealthy({ filePath: rt.scope.lockPath }) ? "YES" : "NO");

  console.log("--- Preflight Gates ---");
  console.log("checks=", JSON.stringify(evaluated.checks));
  console.log("paperModeConfirmed=", evaluated.paperModeConfirmed);
  console.log("realTradingDisabled=", evaluated.realTradingDisabled);
  console.log("credentialReady=", evaluated.credentialReady);
  console.log("kisAuthReady=", evaluated.kisAuthReady);
  console.log("accountResolved=", evaluated.accountResolved);
  console.log("startupSyncReady=", evaluated.startupSyncReady);
  console.log("reconciliationHealthy=", evaluated.reconciliationHealthy);
  console.log("workerLockReady=", evaluated.workerLockReady);
  console.log("marketDataReady=", evaluated.marketDataReady);
  console.log("riskReady=", evaluated.riskReady);
  console.log("idempotencyReady=", evaluated.idempotencyReady);
  console.log("unknownOrdersClear=", evaluated.unknownOrdersClear);
  console.log("blockers=", evaluated.blockers.join(",") || "(none)");
  console.log(
    "blockersContainSuccessLeak=",
    evaluated.blockers.some((b) => /HEALTHY|READY|PASS/i.test(b)) ? "YES" : "NO",
  );
  console.log("readyForPaperAutoTrading=", evaluated.readyForPaperAutoTrading ? "true" : "false");
  console.log(
    "FinalVerdict=",
    evaluated.readyForPaperAutoTrading ? "READY_FOR_PAPER_AUTO_TRADING" : "NOT_READY",
  );
  console.log("OrdersExecutedDuringPreflight=0");

  releaseWorkerLock(workerId, { filePath: rt.scope.lockPath });
  process.exit(evaluated.readyForPaperAutoTrading ? 0 : 2);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
