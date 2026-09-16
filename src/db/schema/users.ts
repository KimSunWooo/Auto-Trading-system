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

export const users = mysqlTable(
  "users",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    email: varchar("email", { length: 320 }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("USER"),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    lastLoginAt: datetime("last_login_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
    deletedAt: datetime("deleted_at", { fsp: 6, mode: "string" }),
  },
  (table) => [
    index("ix_users_status").on(table.status),
    uniqueIndex("uq_users_email").on(table.email),
  ],
);

export const userSettings = mysqlTable(
  "user_settings",
  {
    userId: char("user_id", { length: 36 }).primaryKey().notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Seoul"),
    defaultMarket: varchar("default_market", { length: 20 }),
    defaultCurrency: char("default_currency", { length: 3 }).notNull().default("KRW"),
    notificationEnabled: boolean("notification_enabled").notNull().default(true),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
  ],
);

export const userConsents = mysqlTable(
  "user_consents",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    consentType: varchar("consent_type", { length: 40 }).notNull(),
    version: varchar("version", { length: 40 }).notNull(),
    acceptedAt: datetime("accepted_at", { fsp: 6, mode: "string" }).notNull(),
    revokedAt: datetime("revoked_at", { fsp: 6, mode: "string" }),
    contextJson: json("context_json"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_user_consents_user").on(table.userId, table.acceptedAt),
    uniqueIndex("uq_user_consents").on(table.userId, table.consentType, table.version),
  ],
);

export const authSessions = mysqlTable(
  "auth_sessions",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    sessionTokenHash: varchar("session_token_hash", { length: 255 }).notNull(),
    expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }).notNull(),
    revokedAt: datetime("revoked_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_auth_sessions_user").on(table.userId, table.expiresAt),
    uniqueIndex("uq_auth_session_token_hash").on(table.sessionTokenHash),
  ],
);
