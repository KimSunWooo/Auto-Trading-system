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

export const reconciliationRuns = mysqlTable(
  "reconciliation_runs",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    triggerType: varchar("trigger_type", { length: 40 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    startedAt: datetime("started_at", { fsp: 6, mode: "string" }).notNull(),
    finishedAt: datetime("finished_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_recon_runs_account_time").on(table.brokerAccountId, table.startedAt),
    index("ix_recon_runs_status").on(table.status),
  ],
);

export const reconciliationItems = mysqlTable(
  "reconciliation_items",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    reconciliationRunId: char("reconciliation_run_id", { length: 36 }).notNull(),
    itemType: varchar("item_type", { length: 30 }).notNull(),
    instrumentId: char("instrument_id", { length: 36 }),
    localReference: varchar("local_reference", { length: 191 }),
    brokerReference: varchar("broker_reference", { length: 191 }),
    localValueJson: json("local_value_json"),
    brokerValueJson: json("broker_value_json"),
    status: varchar("status", { length: 20 }).notNull(),
    message: varchar("message", { length: 1000 }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("fk_recon_items_instrument").on(table.instrumentId),
    index("ix_recon_items_run").on(table.reconciliationRunId),
    index("ix_recon_items_type_status").on(table.itemType, table.status),
  ],
);

export const riskDecisions = mysqlTable(
  "risk_decisions",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    intentId: char("intent_id", { length: 36 }).notNull(),
    decision: varchar("decision", { length: 20 }).notNull(),
    reasonCode: varchar("reason_code", { length: 100 }),
    reasonText: varchar("reason_text", { length: 1000 }),
    requestedQty: decimal("requested_qty", { precision: 28, scale: 8, mode: "string" }),
    approvedQty: decimal("approved_qty", { precision: 28, scale: 8, mode: "string" }),
    requestedAmount: decimal("requested_amount", { precision: 28, scale: 8, mode: "string" }),
    approvedAmount: decimal("approved_amount", { precision: 28, scale: 8, mode: "string" }),
    accountValue: decimal("account_value", { precision: 28, scale: 8, mode: "string" }),
    positionExposure: decimal("position_exposure", { precision: 28, scale: 8, mode: "string" }),
    dailyExposure: decimal("daily_exposure", { precision: 28, scale: 8, mode: "string" }),
    dailyPnl: decimal("daily_pnl", { precision: 28, scale: 8, mode: "string" }),
    detailsJson: json("details_json"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_risk_decisions_decision").on(table.decision, table.createdAt),
    index("ix_risk_decisions_intent").on(table.intentId, table.createdAt),
  ],
);

export const riskLimits = mysqlTable(
  "risk_limits",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    environment: varchar("environment", { length: 20 }).notNull(),
    maxOrderAmount: decimal("max_order_amount", { precision: 28, scale: 8, mode: "string" }),
    maxOrderQty: decimal("max_order_qty", { precision: 28, scale: 8, mode: "string" }),
    maxDailyOrderAmount: decimal("max_daily_order_amount", { precision: 28, scale: 8, mode: "string" }),
    maxDailyOrders: int("max_daily_orders"),
    maxPositionAmount: decimal("max_position_amount", { precision: 28, scale: 8, mode: "string" }),
    maxDailyLoss: decimal("max_daily_loss", { precision: 28, scale: 8, mode: "string" }),
    maxDrawdown: decimal("max_drawdown", { precision: 12, scale: 8, mode: "string" }),
    allowTrading: boolean("allow_trading").notNull().default(false),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_risk_limits_account_env").on(table.brokerAccountId, table.environment),
  ],
);
