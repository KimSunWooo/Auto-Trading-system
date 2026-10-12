/**
 * Read-only PAPER preflight for overnight readiness.
 * No CREATE/ALTER/GRANT. No secrets printed. No broker write.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { loadDbConnection, persistenceMode } from "@/src/db/config";
import { tradingMode, allowLiveTrading } from "@/src/runtime/trading-mode";
import { brokerDriver } from "@/src/brokers/kis-config";
import {
  distributableOrderableCash,
  orderableSnapshot,
  planBuyAmountKrw,
  ruleBudgetMode,
  sumActiveAllocationPct,
  validateAllocationPctSum,
} from "@/src/rules/allocation-ratio";
import type { RuleConfig } from "@/src/rules/config";

function loadDotEnvLocal(): void {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function main() {
  loadDotEnvLocal();
  const cfg = loadDbConnection(process.env);
  if (!cfg) throw new Error("db config missing");
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 8_000,
  });

  const accountId = "e3152ebd-c8f5-432f-8923-287d3163e79c";

  const [acct] = await conn.query(
    `SELECT id, user_id, broker, environment, status, is_default,
            LEFT(account_number_masked,8) AS masked,
            CASE WHEN credential_ref IS NULL OR credential_ref='' THEN 0 ELSE 1 END AS has_cred,
            CASE WHEN physical_account_fingerprint IS NULL OR physical_account_fingerprint='' THEN 0 ELSE 1 END AS has_fp
     FROM broker_accounts WHERE id=?`,
    [accountId],
  );

  const [tas] = await conn.query(
    `SELECT auto_trading_enabled AS autoTrading,
            liquidating,
            circuit_halted AS circuitHalted,
            DATE_FORMAT(CONVERT_TZ(last_engine_at, @@session.time_zone, '+00:00'), '%Y-%m-%dT%H:%i:%s.%fZ') AS lastEngineAtUtc,
            DATE_FORMAT(CONVERT_TZ(last_balance_sync_at, @@session.time_zone, '+00:00'), '%Y-%m-%dT%H:%i:%s.%fZ') AS lastBalanceUtc
     FROM trading_account_state WHERE broker_account_id=?`,
    [accountId],
  );

  const [cash] = await conn.query(
    `SELECT currency, cash_balance, orderable_amount, source,
            DATE_FORMAT(CONVERT_TZ(captured_at, @@session.time_zone, '+00:00'), '%Y-%m-%dT%H:%i:%s.%fZ') AS capturedAtUtc
     FROM cash_balance_snapshots
     WHERE broker_account_id=?
     ORDER BY captured_at DESC LIMIT 4`,
    [accountId],
  );

  const [pos] = await conn.query(
    `SELECT instrument_id, quantity, avg_price, market_value
     FROM positions WHERE broker_account_id=? AND CAST(quantity AS DECIMAL(28,8)) <> 0`,
    [accountId],
  );

  const [ordStatus] = await conn.query(
    `SELECT status, COUNT(*) c FROM orders WHERE broker_account_id=? GROUP BY status`,
    [accountId],
  );

  const [openish] = await conn.query(
    `SELECT COUNT(*) c FROM orders
     WHERE broker_account_id=? AND status IN ('pending','unknown','submitted','open','working','PENDING','UNKNOWN')`,
    [accountId],
  );

  const [recon] = await conn.query(
    `SELECT status, trigger_type,
            DATE_FORMAT(CONVERT_TZ(started_at, @@session.time_zone, '+00:00'), '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAtUtc
     FROM reconciliation_runs WHERE broker_account_id=?
     ORDER BY started_at DESC LIMIT 3`,
    [accountId],
  );

  const [alloc] = await conn.query(
    `SELECT rule_key, enabled, allocation_pct, buy_pct, cash_limit, budget_mode
     FROM rule_allocations WHERE broker_account_id=?`,
    [accountId],
  );

  const [rules] = await conn.query(
    `SELECT rule_key, enabled, strategy_type
     FROM trading_rules WHERE broker_account_id=? OR user_id=(SELECT user_id FROM broker_accounts WHERE id=?)`,
    [accountId, accountId],
  );

  console.log(
    JSON.stringify(
      {
        effective: {
          persistenceMode: persistenceMode(process.env),
          tradingMode: tradingMode(process.env),
          allowLiveTrading: allowLiveTrading(process.env),
          kisMode: process.env.KIS_MODE ?? null,
          paperRuntimeOwner: process.env.PAPER_RUNTIME_OWNER ?? null,
          brokerDriver: brokerDriver(process.env),
          hasMasterKey: Boolean(process.env.BROKER_CREDENTIAL_MASTER_KEY?.trim()),
        },
        account: (acct as object[])[0] ?? null,
        tradingState: (tas as object[])[0] ?? null,
        recentCash: cash,
        positions: { count: (pos as object[]).length, rows: pos },
        orderStatusCounts: ordStatus,
        openishCount: Number((openish as Array<{ c: number }>)[0]?.c ?? 0),
        recentRecon: recon,
        ruleAllocations: alloc,
        tradingRulesSample: (rules as object[]).slice(0, 20),
      },
      null,
      2,
    ),
  );

  // Ratio plan dry-run from latest orderable (no orders)
  const latestCash = (cash as Array<{ orderable_amount: string; cash_balance: string; capturedAtUtc: string }>)[0];
  const orderable = latestCash ? Number(latestCash.orderable_amount) : null;
  const fakeBal = {
    orderableCash: orderable,
    totalDeposit: latestCash ? Number(latestCash.cash_balance) : null,
    fetchedAt: latestCash?.capturedAtUtc ?? null,
    syncedAt: latestCash?.capturedAtUtc ?? null,
  };
  // Build minimal rules from DB allocations for sum validation
  const ruleRows = alloc as Array<{
    rule_key: string;
    enabled: number | boolean;
    allocation_pct: string | number | null;
    buy_pct: string | number | null;
    cash_limit: string | number | null;
    budget_mode: string | null;
  }>;
  const ruleConfig: RuleConfig = {
    version: 1,
    rules: ruleRows.map((r) => ({
      id: r.rule_key,
      name: r.rule_key,
      enabled: Boolean(r.enabled),
      strategyType: "manual" as const,
      buyPct: Number(r.buy_pct ?? 0),
      allocationPct:
        r.allocation_pct == null || r.allocation_pct === ""
          ? null
          : Number(r.allocation_pct),
      cashLimit: r.cash_limit == null ? null : Number(r.cash_limit),
      budgetMode: (r.budget_mode as "legacy_fixed" | "orderable_ratio" | null) ?? null,
      tickers: [],
      params: {},
    })),
  };

  const snap = orderableSnapshot(fakeBal as never);
  const dist = distributableOrderableCash(snap, { intents: [], orders: [] } as never);
  const sumPct = sumActiveAllocationPct(ruleConfig.rules as never);
  const sumOk = validateAllocationPctSum(ruleConfig.rules as never);

  const plans = ruleConfig.rules
    .filter((r) => r.enabled)
    .map((r) => {
      const mode = ruleBudgetMode(r as never);
      const slice =
        mode === "orderable_ratio" && dist.amount != null && r.allocationPct != null
          ? Math.floor(dist.amount * Math.max(0, Math.min(1, r.allocationPct)))
          : Number(r.cashLimit ?? 0);
      const buyable = Math.max(0, slice);
      const planned = planBuyAmountKrw({
        buyableCash: buyable,
        buyPct: r.buyPct,
        sliceKrw: slice,
        minAmountKrw: 0,
        price: null,
      });
      return {
        ruleKey: r.id,
        mode,
        allocationPct: r.allocationPct,
        buyPct: r.buyPct,
        sliceKrw: slice,
        plannedBuyKrw: planned.amountKrw,
        plannedQtyHint: planned.qtyHint,
        block: dist.blockReason,
      };
    });

  console.log(
    JSON.stringify(
      {
        ratioDryRun: {
          orderableCash: snap.orderableCash,
          distributable: dist.amount,
          distributableBlock: dist.blockReason,
          sumActiveAllocationPct: sumPct,
          sumValidationOk: sumOk === true || (sumOk as { ok?: boolean }).ok !== false,
          sumValidation: sumOk,
          plans,
        },
      },
      null,
      2,
    ),
  );

  await conn.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.slice(0, 240) : e);
  process.exit(1);
});
