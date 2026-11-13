/**
 * Isolation MySQL: strategy PUT-style persist must upsert trading_rules then
 * rule_allocations in one TX using the validated RuleConfigFile (not disk).
 * On DB failure the strategy file must stay unchanged.
 *
 * Uses loopback docker MySQL `auto_trading_test` only — never ops RDS.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { createPaperState } from "@/lib/engine";
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { getDb, getMysqlPool, resetDbClientForTest, type AppDb } from "@/src/db/client";
import { setMirrorLedgerForTest } from "@/src/db/mirror";
import { resetPersistGenerationForTest } from "@/src/db/ledger-tx";
import { MysqlLedger, resetMysqlLedgerForTest } from "@/src/db/mysql-ledger";
import * as schema from "@/src/db/schema";
import { extractMysqlErrorDetails, formatMysqlErrorForLog } from "@/src/db/mysql-error";
import { createRuleConfigStore } from "@/src/runtime/rule-config-store";
import {
  createTradingStateStore,
  resetTradingStateStoresForTest,
} from "@/src/runtime/trading-state-store";
import { syncAllocationsToRules } from "@/src/rules/config";
import { blankRule, EMPTY_RULE_CONFIG, type RuleConfigFile } from "@/src/rules/params";

const TEST_URL = "mysql://autotrading_app:local@127.0.0.1:3307/auto_trading_test";
const ACCOUNT = randomUUID();
const USER = randomUUID();

const prevUrl = process.env.DATABASE_URL;
const prevMode = process.env.PERSISTENCE_MODE;

let mysqlReady = false;
let skipReason = "auto_trading_test unavailable";
let testDb: AppDb | null = null;

before(async () => {
  // Bootstrap .env.local once (envBootstrapped latch), then force isolation URL and
  // rebuild the singleton pool so MysqlLedger.transaction / getMysqlPool hit :3307.
  resetDbClientForTest();
  resetMysqlLedgerForTest();
  void getMysqlPool(); // loads .env.local (RDS) into process.env + pool
  process.env.DATABASE_URL = TEST_URL;
  process.env.PERSISTENCE_MODE = "database";
  resetDbClientForTest(); // drop RDS pool; envBootstrapped stays true → no reload
  resetMysqlLedgerForTest();

  const pool = getMysqlPool();
  testDb = getDb();
  if (!pool || !testDb) {
    skipReason = "isolation MySQL pool unavailable";
    return;
  }
  // Opt into real MySQL inside node:test (resolveMirrorLedger normally returns null).
  setMirrorLedgerForTest(new MysqlLedger(testDb));

  try {
    await pool.query("SELECT 1");
    const hostRows = (await pool.query("SELECT DATABASE() AS db")) as [
      Array<{ db: string }>,
      unknown,
    ];
    const dbName = hostRows[0]?.[0]?.db;
    if (dbName !== "auto_trading_test") {
      skipReason = `expected auto_trading_test, got ${dbName ?? "null"}`;
      return;
    }
    // Bring users table up to drizzle schema when the isolation DB is behind.
    for (const ddl of [
      "ALTER TABLE users ADD COLUMN password_hash varchar(512) NULL",
      "ALTER TABLE users ADD COLUMN paper_broker_account_id char(36) NULL",
      "ALTER TABLE users ADD COLUMN real_broker_account_id char(36) NULL",
    ]) {
      try {
        await pool.query(ddl);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "ER_DUP_FIELDNAME") throw err;
      }
    }
    const fp = paperPhysicalAccountFingerprint(`iso-${ACCOUNT.slice(0, 8)}`);
    await testDb.insert(schema.users).values({
      id: USER,
      email: `strategy-iso-${USER.slice(0, 8)}@example.test`,
      displayName: "strategy-iso",
      role: "USER",
      status: "ACTIVE",
    });
    await testDb.insert(schema.brokerAccounts).values({
      id: ACCOUNT,
      userId: USER,
      broker: "KIS",
      environment: "PAPER",
      displayName: "ISO PAPER",
      accountNumberMasked: "****ISO1",
      baseCurrency: "KRW",
      status: "ACTIVE",
      isDefault: true,
      credentialRef: null,
      physicalAccountFingerprint: fp,
    });
    mysqlReady = true;
  } catch (err) {
    skipReason = err instanceof Error ? err.message : String(err);
  }
});

after(async () => {
  try {
    if (mysqlReady && testDb) {
      await testDb.delete(schema.ruleAllocations).where(eq(schema.ruleAllocations.brokerAccountId, ACCOUNT));
      await testDb.delete(schema.tradingRules).where(eq(schema.tradingRules.brokerAccountId, ACCOUNT));
      await testDb
        .delete(schema.tradingAccountState)
        .where(eq(schema.tradingAccountState.brokerAccountId, ACCOUNT));
      await testDb.delete(schema.brokerAccounts).where(eq(schema.brokerAccounts.id, ACCOUNT));
      await testDb.delete(schema.users).where(eq(schema.users.id, USER));
    }
  } catch {
    // best-effort cleanup
  }
  resetTradingStateStoresForTest();
  resetPersistGenerationForTest();
  setMirrorLedgerForTest(null);
  resetMysqlLedgerForTest();
  if (prevUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevUrl;
  if (prevMode === undefined) delete process.env.PERSISTENCE_MODE;
  else process.env.PERSISTENCE_MODE = prevMode;
  resetDbClientForTest();
});

test("formatMysqlErrorForLog keeps cause.code errno constraint", () => {
  const driver = {
    code: "ER_NO_REFERENCED_ROW_2",
    errno: 1452,
    sqlState: "23000",
    sqlMessage:
      "Cannot add or update a child row: a foreign key constraint fails (`auto_trading_test`.`rule_allocations`, CONSTRAINT `fk_rule_allocations_rule` FOREIGN KEY (`broker_account_id`, `rule_key`) REFERENCES `trading_rules` (`broker_account_id`, `rule_key`))",
  };
  const drizzle = Object.assign(new Error("Failed query: insert into `rule_allocations`"), {
    cause: driver,
  });
  const wrapped = Object.assign(new Error(drizzle.message), {
    code: "DATABASE_LEDGER_FAILED",
    name: "DatabaseLedgerError",
    cause: drizzle,
  });
  const details = extractMysqlErrorDetails(wrapped);
  assert.equal(details.code, "ER_NO_REFERENCED_ROW_2");
  assert.equal(details.errno, 1452);
  assert.equal(details.constraint, "fk_rule_allocations_rule");
  assert.match(formatMysqlErrorForLog(wrapped), /cause\.code=ER_NO_REFERENCED_ROW_2/);
  assert.match(formatMysqlErrorForLog(wrapped), /errno=1452/);
  assert.match(formatMysqlErrorForLog(wrapped), /constraint=fk_rule_allocations_rule/);
});

test("MySQL: new UUID 10% ratio rule + allocation commit together; file only after success", async (t) => {
  if (!mysqlReady || !testDb) {
    t.skip(skipReason);
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "strategy-iso-"));
  const statePath = path.join(dir, "accounts", ACCOUNT, "state.json");
  const strategyPath = path.join(dir, "accounts", ACCOUNT, "strategy-config.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(createPaperState()), "utf8");
  writeFileSync(strategyPath, `${JSON.stringify(EMPTY_RULE_CONFIG, null, 2)}\n`, "utf8");

  const rules = createRuleConfigStore(strategyPath);
  assert.equal(rules.get().rules.length, 0);

  const newRuleId = randomUUID();
  const config: RuleConfigFile = {
    version: 1,
    rules: [
      blankRule({
        id: newRuleId,
        name: "iso-10pct",
        ticker: "005930",
        enabled: true,
        budgetMode: "orderable_ratio",
        allocationPct: 0.1,
        budget: 0,
      }),
    ],
  };

  resetTradingStateStoresForTest();
  const store = createTradingStateStore({
    statePath,
    brokerAccountId: ACCOUNT,
    getRuleConfig: () => rules.get(),
  });

  try {
    await store.mutateStore(
      (state) => syncAllocationsToRules(state, config.rules),
      { durable: true, projectMode: "full", ruleConfig: config },
    );

    const ruleRows = await testDb
      .select()
      .from(schema.tradingRules)
      .where(
        and(eq(schema.tradingRules.brokerAccountId, ACCOUNT), eq(schema.tradingRules.ruleKey, newRuleId)),
      );
    const allocRows = await testDb
      .select()
      .from(schema.ruleAllocations)
      .where(
        and(
          eq(schema.ruleAllocations.brokerAccountId, ACCOUNT),
          eq(schema.ruleAllocations.ruleKey, newRuleId),
        ),
      );
    assert.equal(ruleRows.length, 1, "trading_rules row must exist");
    assert.equal(allocRows.length, 1, "rule_allocations row must exist");
    assert.equal(ruleRows[0]?.name, "iso-10pct");

    assert.equal(rules.get().rules.length, 0);
    assert.equal(JSON.parse(readFileSync(strategyPath, "utf8")).rules.length, 0);

    rules.commit(config);
    assert.equal(rules.get().rules.length, 1);
    assert.equal(rules.get().rules[0]?.id, newRuleId);
    assert.equal(rules.get().rules[0]?.allocationPct, 0.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetTradingStateStoresForTest();
  }
});

test("MySQL: without ruleConfig FK fails and strategy file is not updated", async (t) => {
  if (!mysqlReady || !testDb) {
    t.skip(skipReason);
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "strategy-iso-fail-"));
  const statePath = path.join(dir, "accounts", ACCOUNT, "state.json");
  const strategyPath = path.join(dir, "accounts", ACCOUNT, "strategy-config.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(createPaperState()), "utf8");
  writeFileSync(strategyPath, `${JSON.stringify({ ...EMPTY_RULE_CONFIG, version: 0 }, null, 2)}\n`, "utf8");

  const rules = createRuleConfigStore(strategyPath);
  const orphanId = randomUUID();
  const config: RuleConfigFile = {
    version: 1,
    rules: [
      blankRule({
        id: orphanId,
        name: "should-not-land",
        ticker: "069500",
        enabled: true,
        budgetMode: "orderable_ratio",
        allocationPct: 0.1,
      }),
    ],
  };

  resetTradingStateStoresForTest();
  const store = createTradingStateStore({
    statePath,
    brokerAccountId: ACCOUNT,
    getRuleConfig: () => rules.get(),
  });

  let failed = false;
  try {
    await store.mutateStore(
      (state) => syncAllocationsToRules(state, config.rules),
      { durable: true, projectMode: "full" },
    );
  } catch (err) {
    failed = true;
    const details = extractMysqlErrorDetails(err);
    const msg = err instanceof Error ? err.message : String(err);
    const logLine = formatMysqlErrorForLog(err);
    assert.ok(
      details.errno === 1452 ||
        details.code === "ER_NO_REFERENCED_ROW_2" ||
        details.constraint === "fk_rule_allocations_rule" ||
        /fk_rule_allocations_rule|1452|ER_NO_REFERENCED/i.test(`${logLine} ${msg}`),
      `expected FK failure, got details=${JSON.stringify(details)} log=${logLine} msg=${msg}`,
    );
  }
  assert.equal(failed, true, "persist must fail without ruleConfig");

  assert.equal(rules.get().rules.length, 0);
  assert.equal(JSON.parse(readFileSync(strategyPath, "utf8")).rules.length, 0);

  const orphanRules = await testDb
    .select()
    .from(schema.tradingRules)
    .where(
      and(eq(schema.tradingRules.brokerAccountId, ACCOUNT), eq(schema.tradingRules.ruleKey, orphanId)),
    );
  const orphanAlloc = await testDb
    .select()
    .from(schema.ruleAllocations)
    .where(
      and(
        eq(schema.ruleAllocations.brokerAccountId, ACCOUNT),
        eq(schema.ruleAllocations.ruleKey, orphanId),
      ),
    );
  assert.equal(orphanRules.length, 0);
  assert.equal(orphanAlloc.length, 0);

  rmSync(dir, { recursive: true, force: true });
  resetTradingStateStoresForTest();
});
