#!/usr/bin/env tsx
/**
 * Operator-only one-shot PAPER credential rebind after master-key loss.
 *
 * NEVER:
 * - decrypts existing ciphertext under a lost key
 * - places BUY/SELL/CANCEL
 * - enables autoTrading
 * - accepts secrets via CLI argv (shell history risk)
 *
 * Reads from .env.local / process env:
 *   RECOVERY_BROKER_ACCOUNT_ID
 *   RECOVERY_KIS_PAPER_ACCOUNT_NO
 *   RECOVERY_KIS_PAPER_APP_KEY
 *   RECOVERY_KIS_PAPER_APP_SECRET
 *   BROKER_CREDENTIAL_MASTER_KEY
 *   RECOVERY_APPLY=false|true          (default false = dry-run)
 *   RECOVERY_CONFIRM=REBINDS_EXISTING_PAPER_CREDENTIAL  (required for apply)
 *
 * Usage:
 *   npm run credentials:rebind-paper
 *   RECOVERY_APPLY=true RECOVERY_CONFIRM=REBINDS_EXISTING_PAPER_CREDENTIAL npm run credentials:rebind-paper
 */
import { loadLocalEnv } from "@/src/db/load-env";

// Load BEFORE DB / crypto master-key reads.
loadLocalEnv();

process.env.ALLOW_LIVE_TRADING = "false";
process.env.KIS_MODE = process.env.KIS_MODE?.trim() || "paper";
delete process.env.KIS_REAL_APP_KEY;
delete process.env.KIS_REAL_APP_SECRET;
delete process.env.KIS_REAL_ACCOUNT_NO;

async function main(): Promise<void> {
  const {
    rebindPaperCredential,
    readRebindParamsFromEnv,
  } = await import("@/src/auth/rebind-paper-credential");

  const params = readRebindParamsFromEnv(process.env);
  console.log("credentials:rebind-paper");
  console.log("mode:", params.apply ? "APPLY" : "DRY-RUN");
  console.log(
    "brokerAccountId:",
    params.brokerAccountId ? `${params.brokerAccountId.slice(0, 8)}…` : "(missing)",
  );
  console.log("REAL: LOCKED");
  console.log("ORDERS: none (this script never places orders)");

  const result = await rebindPaperCredential({
    brokerAccountId: params.brokerAccountId,
    accountNo: params.accountNo,
    appKey: params.appKey,
    appSecret: params.appSecret,
    apply: params.apply,
    confirm: params.confirm,
  });

  console.log("ok:", result.ok ? "YES" : "NO");
  console.log("applied:", result.applied ? "YES" : "NO");
  console.log("accountMasked:", result.accountMasked);
  console.log("kisValidationOk:", result.kisValidationOk ? "YES" : "NO");
  console.log("autoTradingOff:", result.autoTradingOff ? "YES" : "NO");
  console.log("startupSyncRequired:", result.startupSyncRequired ? "YES" : "NO");
  console.log("checks:", result.checks.join(","));
  if (result.error) {
    console.error("error:", result.error);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
