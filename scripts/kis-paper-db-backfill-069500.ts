/**
 * Backfill missing KIS PAPER fills (069500 Oct-1 ODNOs) into TARGET DB.
 * Source of truth: KIS-verified rows already present in JSON.
 * Does NOT place broker orders. Idempotent via localOrderId / ODNO / executionKey.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

process.env.ALLOW_LIVE_TRADING = "false";
process.env.KIS_MODE = "paper";
process.env.TRADING_MODE = "live_test";
process.env.BROKER = "kis";
process.env.PERSISTENCE_MODE = "mirror";
delete process.env.KIS_LIVE_CONFIRM;

const TARGET = "e3152ebd-c8f5-432f-8923-287d3163e79c";
const SYMBOL = "069500";
/** Verified KIS ODNOs missing from DB (JSON already has them). */
const MISSING_ODNOS = new Set([
  "0000027577",
  "0000027629",
  "0000027784",
  "0000027814",
  "0000027964",
  "0000028028",
  "0000028189",
  "0000028215",
  "0000028316",
  "0000028353",
]);

async function main() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("@/src/db/client");
  const schema = await import("@/src/db/schema");
  const { getMysqlLedger } = await import("@/src/db/mysql-ledger");
  const { projectAppState } = await import("@/src/db/projector");
  const { instrumentIdFor } = await import("@/src/db/mapping");
  type AppState = import("@/lib/types").AppState;

  console.log("=== DB backfill 069500 +10 (read JSON → mirror, no broker) ===");
  console.log("TARGET=", TARGET);
  console.log("ALLOW_LIVE_TRADING=", process.env.ALLOW_LIVE_TRADING);
  console.log("PERSISTENCE_MODE=", process.env.PERSISTENCE_MODE);

  const statePath = path.join(process.cwd(), "data/accounts", TARGET, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as AppState;
  if (state.settings.autoTrading) {
    throw new Error("REFUSED: autoTrading must stay OFF during backfill");
  }

  const parents = (state.orders ?? []).filter(
    (o) => o.code === SYMBOL && !o.parentOrderId && MISSING_ODNOS.has(o.brokerOrderNo ?? ""),
  );
  console.log("json.missingOdnos.found=", parents.length);
  for (const o of parents) {
    console.log(
      JSON.stringify({
        odno: o.brokerOrderNo,
        intentId: o.intentId,
        qty: o.qty,
        createdAt: o.createdAt,
      }),
    );
  }
  if (parents.length !== 10) {
    throw new Error(`Expected 10 JSON parents for missing ODNOs, got ${parents.length}`);
  }

  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  const account = (
    await db.select().from(schema.brokerAccounts).where(eq(schema.brokerAccounts.id, TARGET)).limit(1)
  )[0];
  if (!account) throw new Error("account missing");

  const beforeOrders = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.brokerAccountId, TARGET));
  const beforeExecs = await db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.brokerAccountId, TARGET));
  console.log("db.before.orders=", beforeOrders.length, "execs=", beforeExecs.length);

  const ledger = getMysqlLedger(process.env);
  const first = await projectAppState(ledger, state, {
    brokerAccountId: TARGET,
    provenance: "RUNTIME",
    env: process.env,
  });
  console.log("project.pass1=", first.imported);

  // Idempotency: second pass must not grow unique ODNOs / execution keys.
  const second = await projectAppState(ledger, state, {
    brokerAccountId: TARGET,
    provenance: "RUNTIME",
    env: process.env,
  });
  console.log("project.pass2=", second.imported);

  const instrumentId = instrumentIdFor(SYMBOL);
  const afterOrders = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.brokerAccountId, TARGET));
  const afterExecs = await db
    .select()
    .from(schema.executions)
    .where(eq(schema.executions.brokerAccountId, TARGET));
  const afterIntents = await db
    .select()
    .from(schema.orderIntents)
    .where(eq(schema.orderIntents.brokerAccountId, TARGET));
  const afterPos = await db
    .select()
    .from(schema.positions)
    .where(eq(schema.positions.brokerAccountId, TARGET));

  const symOrders = afterOrders.filter((o) => o.instrumentId === instrumentId);
  const symExecs = afterExecs.filter((e) => e.instrumentId === instrumentId);
  const symIntents = afterIntents.filter((i) => i.instrumentId === instrumentId);
  const symPos = afterPos.filter((p) => p.instrumentId === instrumentId);
  const odnos = new Set(symOrders.map((o) => o.brokerOrderNo).filter(Boolean));
  const execKeys = new Set(symExecs.map((e) => e.executionKey));

  console.log("\n=== VERIFY ===");
  console.log("DB qty =", symPos.reduce((s, p) => s + Number(p.quantity), 0));
  console.log("DB orders =", symOrders.length, "uniqueOdnos=", odnos.size);
  console.log("DB executions =", symExecs.length, "uniqueKeys=", execKeys.size);
  console.log("DB intents =", symIntents.length);
  console.log(
    "odnos=",
    [...odnos].sort().join(","),
  );
  console.log(
    "missingStillAbsent=",
    [...MISSING_ODNOS].filter((o) => ![...odnos].some((x) => String(x).replace(/^0+/, "") === o.replace(/^0+/, ""))),
  );
  console.log("duplicate_order_rows=", symOrders.length - odnos.size);
  console.log("duplicate_exec_keys=", symExecs.length - execKeys.size);
  console.log("pass2_new_orders=", second.imported.orders);
  console.log("pass2_new_execs=", second.imported.executions);
  console.log("broker.orders.placed=0");
  console.log("autoTrading=", state.settings.autoTrading);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
