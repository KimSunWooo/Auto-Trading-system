/**
 * Read-only-ish cost probe: count ledger rows + time a tick projection once.
 * Does write via projectAppState in a transaction that we measure — use only on PAPER local soak.
 * Prints no secrets / bind values.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { loadDbConnection } from "@/src/db/config";
import { getMysqlLedger, resetMysqlLedgerForTest } from "@/src/db/mysql-ledger";
import { resetDbClientForTest } from "@/src/db/client";
import { projectAppState } from "@/src/db/projector";
import { reconstituteAppStateFromLedger } from "@/src/db/reconstitute-state";

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
  process.env.PERSISTENCE_MODE = process.env.PERSISTENCE_MODE || "database";
  const cfg = loadDbConnection(process.env);
  if (!cfg) throw new Error("no db config");
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
  const counts: Record<string, number> = {};
  for (const [name, sql] of [
    ["orders", `SELECT COUNT(*) AS c FROM orders WHERE broker_account_id=?`],
    ["order_intents", `SELECT COUNT(*) AS c FROM order_intents WHERE broker_account_id=?`],
    ["executions", `SELECT COUNT(*) AS c FROM executions WHERE broker_account_id=?`],
    ["positions", `SELECT COUNT(*) AS c FROM positions WHERE broker_account_id=?`],
    ["rule_allocations", `SELECT COUNT(*) AS c FROM rule_allocations WHERE broker_account_id=?`],
    ["auto_conditions", `SELECT COUNT(*) AS c FROM auto_conditions WHERE broker_account_id=?`],
    ["dca_plans", `SELECT COUNT(*) AS c FROM dca_plans WHERE broker_account_id=?`],
    ["order_events", `SELECT COUNT(*) AS c FROM order_events oe INNER JOIN orders o ON o.id=oe.order_id WHERE o.broker_account_id=?`],
  ] as const) {
    const [rows] = await conn.query(sql, [accountId]);
    counts[name] = Number((rows as Array<{ c: number }>)[0]?.c ?? 0);
  }
  const [flags] = await conn.query(
    `SELECT auto_trading_enabled AS autoTrading,
            last_engine_at IS NOT NULL AS hasLastEngine,
            last_balance_sync_at IS NOT NULL AS hasLastBalance,
            DATE_FORMAT(last_engine_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastEngineAt,
            DATE_FORMAT(last_balance_sync_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastBalanceSyncAt
     FROM trading_account_state WHERE broker_account_id=?`,
    [accountId],
  );
  console.log(
    JSON.stringify(
      {
        accountIdPrefix: accountId.slice(0, 8),
        counts,
        flags: (flags as object[])[0] ?? null,
      },
      null,
      2,
    ),
  );
  await conn.end();

  // Time tick projection of reconstituted state
  resetDbClientForTest();
  resetMysqlLedgerForTest();
  const ledger = getMysqlLedger(process.env);
  const t0 = Date.now();
  const state = await reconstituteAppStateFromLedger(ledger, accountId);
  const loadMs = Date.now() - t0;
  console.log(
    JSON.stringify({
      stage: "reconstitute",
      ms: loadMs,
      orders: state.orders?.length ?? 0,
      intents: state.intents?.length ?? 0,
      positions: state.positions?.length ?? 0,
      allocations: state.allocations?.length ?? 0,
      autoTrading: state.settings?.autoTrading ?? null,
    }),
  );

  const stages: Array<{ stage: string; at: number }> = [];
  const t1 = Date.now();
  try {
    await projectAppState(ledger, state, {
      brokerAccountId: accountId,
      projectMode: "tick",
      env: process.env,
      txOpts: {
        timeoutMs: 120_000,
        onStage: (stage) => stages.push({ stage, at: Date.now() - t1 }),
      },
    });
    console.log(
      JSON.stringify({
        stage: "project_tick",
        ok: true,
        ms: Date.now() - t1,
        stages,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        stage: "project_tick",
        ok: false,
        ms: Date.now() - t1,
        stages,
        error: err instanceof Error ? err.message.slice(0, 200) : "error",
      }),
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.slice(0, 200) : e);
  process.exit(1);
});
