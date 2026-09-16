import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const tradingRules = mysqlTable(
  "trading_rules",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    ruleKey: varchar("rule_key", { length: 100 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }),
    name: varchar("name", { length: 160 }).notNull(),
    kind: varchar("kind", { length: 60 }).notNull(),
    intervalMs: bigint("interval_ms", { mode: "number" }),
    fastMa: int("fast_ma"),
    slowMa: int("slow_ma"),
    buyPct: decimal("buy_pct", { precision: 12, scale: 8, mode: "string" }),
    sliceAmount: decimal("slice_amount", { precision: 28, scale: 8, mode: "string" }),
    minAmount: decimal("min_amount", { precision: 28, scale: 8, mode: "string" }),
    stopLossPct: decimal("stop_loss_pct", { precision: 12, scale: 8, mode: "string" }),
    takeProfitPct: decimal("take_profit_pct", { precision: 12, scale: 8, mode: "string" }),
    budget: decimal("budget", { precision: 28, scale: 8, mode: "string" }),
    enabled: boolean("enabled").notNull().default(true),
    configJson: json("config_json"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_trading_rules_instrument").on(table.instrumentId),
    index("ix_trading_rules_user").on(table.userId, table.enabled),
    uniqueIndex("uq_trading_rules_key").on(table.brokerAccountId, table.ruleKey),
  ],
);

export const ruleAllocations = mysqlTable(
  "rule_allocations",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    ruleKey: varchar("rule_key", { length: 100 }).notNull(),
    budget: decimal("budget", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    balance: decimal("balance", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: datetime("last_run_at", { fsp: 6, mode: "string" }),
    lastMessage: varchar("last_message", { length: 500 }),
    metaJson: json("meta_json"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_rule_allocations").on(table.brokerAccountId, table.ruleKey),
  ],
);

export const autoConditions = mysqlTable(
  "auto_conditions",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    conditionKey: varchar("condition_key", { length: 120 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    configJson: json("config_json").notNull(),
    lastTriggeredAt: datetime("last_triggered_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("fk_auto_conditions_instrument").on(table.instrumentId),
    index("ix_auto_conditions_status").on(table.brokerAccountId, table.status),
    uniqueIndex("uq_auto_conditions").on(table.brokerAccountId, table.conditionKey),
  ],
);

export const dcaPlans = mysqlTable(
  "dca_plans",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    planKey: varchar("plan_key", { length: 120 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    configJson: json("config_json").notNull(),
    nextRunAt: datetime("next_run_at", { fsp: 6, mode: "string" }),
    lastRunAt: datetime("last_run_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("fk_dca_plans_instrument").on(table.instrumentId),
    index("ix_dca_plans_next_run").on(table.status, table.nextRunAt),
    uniqueIndex("uq_dca_plans").on(table.brokerAccountId, table.planKey),
  ],
);

export const tradeSignals = mysqlTable(
  "trade_signals",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    ruleKey: varchar("rule_key", { length: 100 }).notNull(),
    signalType: varchar("signal_type", { length: 20 }).notNull(),
    confidence: decimal("confidence", { precision: 12, scale: 8, mode: "string" }),
    referencePrice: decimal("reference_price", { precision: 28, scale: 8, mode: "string" }),
    reasonCode: varchar("reason_code", { length: 80 }),
    reasonText: varchar("reason_text", { length: 1000 }),
    marketDataSnapshot: json("market_data_snapshot"),
    status: varchar("status", { length: 20 }).notNull().default("GENERATED"),
    generatedAt: datetime("generated_at", { fsp: 6, mode: "string" }).notNull(),
    consumedAt: datetime("consumed_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_trade_signals_account_time").on(table.brokerAccountId, table.generatedAt),
    index("ix_trade_signals_instrument_time").on(table.instrumentId, table.generatedAt),
    index("ix_trade_signals_status").on(table.status),
  ],
);

export const tradingCandidates = mysqlTable(
  "trading_candidates",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    source: varchar("source", { length: 40 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("CANDIDATE"),
    score: decimal("score", { precision: 12, scale: 8, mode: "string" }),
    reason: varchar("reason", { length: 1000 }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("fk_candidates_account").on(table.brokerAccountId),
    index("ix_candidates_instrument_status").on(table.instrumentId, table.status),
    index("ix_candidates_user_status").on(table.userId, table.status),
  ],
);

export const watchlists = mysqlTable(
  "watchlists",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_watchlist_name").on(table.userId, table.name),
  ],
);

export const watchlistItems = mysqlTable(
  "watchlist_items",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    watchlistId: char("watchlist_id", { length: 36 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_watchlist_items_instrument").on(table.instrumentId),
    uniqueIndex("uq_watchlist_item").on(table.watchlistId, table.instrumentId),
  ],
);
