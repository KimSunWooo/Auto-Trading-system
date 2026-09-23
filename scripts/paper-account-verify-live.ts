/**
 * Read-only live PAPER account verification before first BUY test.
 * Places ZERO orders. Prints masked account + holdings + cash match report.
 *
 * Usage:
 *   npx tsx scripts/paper-account-verify-live.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/src/db/client";
import * as schema from "@/src/db/schema";
import { accountDataDir, loadPaperSecretForAccount } from "@/src/auth/paper-accounts";
import { selectOwnedPaperAccount } from "@/src/auth/select-paper-account";
import { verifyPaperAccountForUser } from "@/src/auth/paper-account-verify";
import { KisClient } from "@/src/brokers/kis-client";
import { kisConfigFromPaperCredentials } from "@/src/brokers/kis-config";
import { resolvePaperRuntimeOwner } from "@/src/runtime/paper-runtime-owner";
import {
  emptyStartupSync,
  runPaperStartupSync,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";
import { createTradingStateStore } from "@/src/runtime/trading-state-store";

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function mask(accountNo: string): string {
  const d = accountNo.replace(/\D/g, "");
  return d.length >= 4 ? `****${d.slice(-4)}` : "****";
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  process.env.ALLOW_LIVE_TRADING = "false";
  process.env.PAPER_RUNTIME_OWNER = process.env.PAPER_RUNTIME_OWNER ?? "accounts";
  process.env.BROKER = process.env.BROKER ?? "kis";
  process.env.TRADING_MODE = process.env.TRADING_MODE ?? "live_test";
  process.env.KIS_MODE = process.env.KIS_MODE ?? "paper";

  const owner = resolvePaperRuntimeOwner(process.env, { freeze: false });
  console.log("PAPER_RUNTIME_OWNER:", owner.ok ? owner.owner : owner.error);
  console.log("ALLOW_LIVE_TRADING:", process.env.ALLOW_LIVE_TRADING);
  console.log("usesPaperStartupSync:", usesPaperStartupSync());
  console.log("REAL: LOCKED");
  console.log("ORDERS: Domestic BUY/SELL/CANCEL = 0 (this script never orders)");
  console.log("");

  const db = getDb();
  if (!db) {
    console.error("FAIL: DATABASE_URL unavailable");
    process.exitCode = 1;
    return;
  }

  const rows = await db
    .select()
    .from(schema.brokerAccounts)
    .where(
      and(
        eq(schema.brokerAccounts.status, "ACTIVE"),
        eq(schema.brokerAccounts.environment, "PAPER"),
        eq(schema.brokerAccounts.broker, "kis"),
      ),
    );

  if (rows.length === 0) {
    console.error("FAIL: no ACTIVE PAPER kis broker_accounts");
    process.exitCode = 1;
    return;
  }

  const withFp = rows.filter((r) => r.physicalAccountFingerprint);
  const account = withFp.find((r) => r.isDefault) ?? withFp[0] ?? rows[0]!;
  const userId = account.userId;
  console.log("User:", `${userId.slice(0, 8)}…`);
  console.log("Selected Broker Account ID:", account.id);
  console.log("Account Mask:", account.accountNumberMasked || "(from secret)");
  console.log("Environment:", account.environment);
  console.log("");

  const secret = await loadPaperSecretForAccount(account.id);
  if (!secret) {
    console.error("FAIL: encrypted credential missing");
    process.exitCode = 1;
    return;
  }
  console.log("Encrypted Credential Loaded: YES");
  console.log("Account Mask (secret):", mask(secret.accountNo));

  const dir = accountDataDir(account.id);
  const store = createTradingStateStore({ statePath: path.join(dir, "state.json") });
  let state = await store.getState();

  const pre = await verifyPaperAccountForUser({ userId, state: null });
  console.log("\n--- Fresh Broker Query ---");
  console.log("Fresh KIS Balance Query:", pre.freshBrokerQuery ? "PASS" : "FAIL");
  console.log("Pages Fetched:", pre.pagesFetched);
  console.log("Pagination Complete:", pre.paginationComplete ? "YES" : "NO");
  console.log("Fingerprint Verified:", pre.fingerprintVerified ? "PASS" : "FAIL");
  console.log("Binding Verified:", pre.bindingVerified ? "PASS" : "FAIL");
  console.log("Blockers:", pre.blockers.join(", ") || "none");

  console.log("\n--- ACTUAL KIS PAPER HOLDINGS ---");
  if (pre.holdings.length === 0) {
    console.log("Holdings: NONE");
  } else {
    console.log("Ticker   Name              Qty      Avg Price");
    for (const h of pre.holdings) {
      console.log(
        `${h.ticker.padEnd(8)}${h.name.slice(0, 16).padEnd(18)}${String(h.qty).padEnd(9)}${Math.round(h.avgPrice).toLocaleString("ko-KR")}`,
      );
    }
  }
  console.log("KIS Holding Count:", pre.holdings.length);
  console.log("KIS dnca_tot_amt:", pre.depositCash.toLocaleString("ko-KR"));
  console.log("KIS ord_psbl_cash:", pre.orderableCash?.toLocaleString("ko-KR") ?? "null");

  if (secret && pre.freshBrokerQuery) {
    try {
      const client = new KisClient(kisConfigFromPaperCredentials(secret));
      const marked = {
        ...state,
        startupSync: {
          ...(state.startupSync ?? emptyStartupSync()),
          status: "SYNCING" as const,
          message: "live verify startup sync",
        },
      };
      const sync = await runPaperStartupSync(marked, client);
      state = sync.state;
      store.persistStateNow(state).catch(() => undefined);
      console.log("\n--- Startup Sync ---");
      console.log("Status:", state.startupSync?.status ?? (sync.ok ? "HEALTHY" : "FAILED"));
      console.log("Position Changes:", state.startupSync?.positionChanges ?? 0);
      console.log("ok:", sync.ok);
      if (sync.error) console.log("error:", sync.error);
    } catch (err) {
      console.log("\n--- Startup Sync ---");
      console.log("Status: FAILED", err instanceof Error ? err.message : err);
    }
  }

  const post = await verifyPaperAccountForUser({ userId, state });
  const localCount = state.positions.filter((p: { qty: number }) => p.qty > 0).length;
  console.log("\n--- Post-Sync Recheck ---");
  console.log("Local Position Count:", localCount);
  console.log("Exact Position Match:", post.localPositionsMatched ? "YES" : "NO");
  console.log("state.kisBalance.cash:", state.kisBalance?.cash?.toLocaleString("ko-KR") ?? "n/a");
  console.log(
    "Exact Deposit Match:",
    state.kisBalance && state.kisBalance.cash === post.depositCash ? "YES" : "NO",
  );
  console.log(
    "state.kisBalance.orderableCash:",
    state.kisBalance?.orderableCash?.toLocaleString("ko-KR") ?? "n/a",
  );
  console.log(
    "Exact Orderable Match:",
    post.orderableCash != null &&
      state.kisBalance?.orderableCash != null &&
      state.kisBalance.orderableCash === post.orderableCash
      ? "YES"
      : "NO / partial",
  );
  console.log("Strategy Allocated Cash (state.cash):", state.cash.toLocaleString("ko-KR"));
  console.log("Compared Against dnca_tot_amt: NO (local ledger ≠ broker deposit)");
  console.log("\nreadyForTrading:", post.readyForTrading ? "YES" : "NO");
  console.log("blockers:", post.blockers.join(", ") || "none");

  try {
    const selected = await selectOwnedPaperAccount(userId);
    console.log("\nDefault Selection Unambiguous: YES");
    console.log("Selected matches verify account:", selected.id === account.id ? "YES" : "NO");
  } catch (err) {
    console.log("\nDefault Selection Unambiguous: NO", err instanceof Error ? err.message : err);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
