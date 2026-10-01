/**
 * PAPER auto-trading preflight + Startup Sync (inquiries only).
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const { invalidateRuntimeScope, markScopeStartupSyncDone, isScopeStartupSyncDone } =
    await import("@/src/runtime/runtime-scope");
  const {
    emptyStartupSync,
    runPaperStartupSync,
    usesPaperStartupSync,
    findActiveUnknownOrder,
  } = await import("@/src/runtime/startup-sync");
  const {
    tryAcquireWorkerLock,
    releaseWorkerLock,
    workerLockHealthy,
  } = await import("@/src/runtime/worker-lock");
  const { evaluatePaperTradingPreflight, runPaperTradingPreflightForUser } = await import(
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
  console.log("masked.match=", maskAccountNumber(secret.accountNo) === account.accountNumberMasked ? "YES" : "NO");

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

  // Auth via read-only balance inquiry (token is internal to KisClient).
  // KIS OAuth is 1/min — do not loop token issuance here.
  try {
    const bal = await rt.scope.kisClient.inquireBalance();
    console.log("kis.auth=", "OK");
    console.log("kis.balance.deposit=", Number.isFinite(bal.cash) ? "set" : "missing");
    console.log("kis.balance.holdings=", bal.holdings?.length ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("kis.auth=", "FAIL", msg.slice(0, 120));
    releaseWorkerLock(workerId, { filePath: rt.scope.lockPath });
    if (/1분당|EGW00201|rate|초당/i.test(msg)) {
      console.log("RemainingBlocker=KIS_TOKEN_RATE_LIMIT (wait >=60s then: npm run paper:preflight)");
    }
    throw err;
  }

  let syncStatus = "IDLE";
  let syncMessage = "";
  await rt.store.mutateStore(async (state) => {
    const marked = {
      ...state,
      settings: { ...state.settings, autoTrading: false },
      startupSync: {
        ...(state.startupSync ?? emptyStartupSync()),
        status: "SYNCING" as const,
        message: "Preflight Startup Sync (inquiries only)",
      },
    };
    const result = await runPaperStartupSync(marked, rt.scope.kisClient);
    syncStatus = result.state.startupSync?.status ?? (result.ok ? "HEALTHY" : "FAILED");
    syncMessage = result.state.startupSync?.message ?? result.error ?? "";
    if (result.ok && syncStatus === "HEALTHY") {
      markScopeStartupSyncDone(account.id, true);
    }
    return { ...result.state, settings: { ...result.state.settings, autoTrading: false } };
  });

  const { markProcessBootStartupVerified } = await import("@/src/runtime/startup-sync");
  if (syncStatus === "HEALTHY") markProcessBootStartupVerified(true);

  // Fresh KIS REST quotes for holdings (not mock/seed) — required for marketDataReady.
  // Skip if market closed; still record blocker honestly.
  try {
    const afterSync = await rt.store.getState();
    const tickers: string[] = [
      ...new Set([
        ...afterSync.positions.filter((p) => p.qty > 0).map((p) => p.code),
        ...(afterSync.kisBalance?.holdings ?? []).map((h) => h.ticker),
      ]),
    ].slice(0, 3);
    if (tickers.length === 0) {
      tickers.push("005930");
    }
    await rt.store.mutateStore(async (state) => {
      const quotes = { ...state.quotes };
      for (const ticker of tickers) {
        try {
          const px = await rt.scope.kisClient.inquirePrice(ticker);
          const prev = quotes[ticker];
          quotes[ticker] = {
            code: ticker,
            name: prev?.name ?? ticker,
            market: prev?.market ?? "KOSPI",
            price: px.price,
            prevClose: px.prevClose ?? px.price,
            open: px.open ?? px.price,
            high: px.high ?? px.price,
            low: px.low ?? px.price,
            volume: px.volume ?? 0,
            bid: px.bid ?? px.price,
            ask: px.ask ?? px.price,
            history: prev?.history?.length ? [...prev.history.slice(-59), px.price] : [px.price],
            source: "kis",
            transport: "rest",
            freshAt: Date.now(),
          };
          console.log("quote.fetched=", ticker, "source=kis");
        } catch (err) {
          console.log(
            "quote.fetch.fail=",
            ticker,
            err instanceof Error ? err.message.slice(0, 80) : "fail",
          );
        }
      }
      return { ...state, quotes };
    });
  } catch (err) {
    console.log("quote.phase.fail=", err instanceof Error ? err.message.slice(0, 100) : err);
  }

  const state = await rt.store.getState();
  console.log("startupSync.status=", syncStatus);
  if (syncMessage) console.log("startupSync.message=", syncMessage.slice(0, 200));
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
  console.log("bootVerified=", isScopeStartupSyncDone(account.id) ? "YES" : "NO");

  const evaluated = evaluatePaperTradingPreflight({
    userId: account.userId,
    state,
    brokerAccountId: account.id,
    workerLockPath: rt.scope.lockPath,
    bootStartupVerified: isScopeStartupSyncDone(account.id),
    credentialOk: true,
    fingerprintOk: fp === account.physicalAccountFingerprint,
    kisAuthOk: true,
  });

  console.log("--- Preflight Gates ---");
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
  console.log("readyForPaperAutoTrading=", evaluated.readyForPaperAutoTrading ? "true" : "false");
  console.log("FinalVerdict=", evaluated.readyForPaperAutoTrading ? "READY_FOR_PAPER_AUTO_TRADING" : "NOT_READY");
  console.log("OrdersExecutedDuringPreflight=0");

  releaseWorkerLock(workerId, { filePath: rt.scope.lockPath });
  process.exit(evaluated.readyForPaperAutoTrading ? 0 : 2);
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
