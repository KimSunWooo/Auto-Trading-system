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

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }),
    brokerAccountId: char("broker_account_id", { length: 36 }),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 80 }),
    entityId: varchar("entity_id", { length: 191 }),
    beforeDataJson: json("before_data_json"),
    afterDataJson: json("after_data_json"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 500 }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_audit_account_time").on(table.brokerAccountId, table.createdAt),
    index("ix_audit_action_time").on(table.action, table.createdAt),
    index("ix_audit_user_time").on(table.userId, table.createdAt),
  ],
);

export const notifications = mysqlTable(
  "notifications",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull().default("INFO"),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    readAt: datetime("read_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_notifications_user_read").on(table.userId, table.readAt, table.createdAt),
  ],
);

export const aiRecommendations = mysqlTable(
  "ai_recommendations",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    candidateId: char("candidate_id", { length: 36 }),
    modelName: varchar("model_name", { length: 160 }).notNull(),
    modelVersion: varchar("model_version", { length: 120 }),
    recommendation: varchar("recommendation", { length: 40 }).notNull(),
    score: decimal("score", { precision: 12, scale: 8, mode: "string" }),
    confidence: decimal("confidence", { precision: 12, scale: 8, mode: "string" }),
    reason: varchar("reason", { length: 2000 }),
    inputSnapshotJson: json("input_snapshot_json"),
    outputRawJson: json("output_raw_json"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("fk_ai_rec_account").on(table.brokerAccountId),
    index("fk_ai_rec_candidate").on(table.candidateId),
    index("ix_ai_rec_instrument_time").on(table.instrumentId, table.createdAt),
    index("ix_ai_rec_user_time").on(table.userId, table.createdAt),
  ],
);

export const migrationRuns = mysqlTable(
  "migration_runs",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    migrationType: varchar("migration_type", { length: 80 }).notNull(),
    sourcePath: varchar("source_path", { length: 500 }),
    status: varchar("status", { length: 20 }).notNull(),
    importedOrders: int("imported_orders").notNull().default(0),
    importedIntents: int("imported_intents").notNull().default(0),
    importedPositions: int("imported_positions").notNull().default(0),
    importedRules: int("imported_rules").notNull().default(0),
    warningsJson: json("warnings_json"),
    startedAt: datetime("started_at", { fsp: 6, mode: "string" }).notNull(),
    finishedAt: datetime("finished_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_migration_runs_type_time").on(table.migrationType, table.startedAt),
  ],
);
