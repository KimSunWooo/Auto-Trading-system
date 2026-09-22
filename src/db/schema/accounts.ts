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

export const brokerAccounts = mysqlTable(
  "broker_accounts",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    userId: char("user_id", { length: 36 }).notNull(),
    broker: varchar("broker", { length: 20 }).notNull(),
    environment: varchar("environment", { length: 20 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    accountNumberMasked: varchar("account_number_masked", { length: 64 }),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("KRW"),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    isDefault: boolean("is_default").notNull().default(false),
    credentialRef: varchar("credential_ref", { length: 255 }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_broker_accounts_status").on(table.status),
    index("ix_broker_accounts_user_env").on(table.userId, table.environment),
  ],
);

export const brokerCredentialRefs = mysqlTable(
  "broker_credential_refs",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    secretProvider: varchar("secret_provider", { length: 40 }).notNull(),
    secretRef: varchar("secret_ref", { length: 255 }).notNull(),
    keyVersion: varchar("key_version", { length: 80 }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_broker_credential_account").on(table.brokerAccountId),
  ],
);

export const tradingAccountState = mysqlTable(
  "trading_account_state",
  {
    brokerAccountId: char("broker_account_id", { length: 36 }).primaryKey().notNull(),
    autoTradingEnabled: boolean("auto_trading_enabled").notNull().default(false),
    onboardingComplete: boolean("onboarding_complete").notNull().default(false),
    liquidating: boolean("liquidating").notNull().default(false),
    circuitHalted: boolean("circuit_halted").notNull().default(false),
    circuitKind: varchar("circuit_kind", { length: 60 }),
    circuitReason: varchar("circuit_reason", { length: 500 }),
    unknownOrderCount: int("unknown_order_count").notNull().default(0),
    lastEngineAt: datetime("last_engine_at", { fsp: 6, mode: "string" }),
    lastBalanceSyncAt: datetime("last_balance_sync_at", { fsp: 6, mode: "string" }),
    lastOrderAt: datetime("last_order_at", { fsp: 6, mode: "string" }),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
  ],
);

/** Encrypted KIS PAPER credential payload (AES-256-GCM). Master key never stored in DB. */
export const brokerSecretPayloads = mysqlTable(
  "broker_secret_payloads",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: varchar("iv", { length: 64 }).notNull(),
    authTag: varchar("auth_tag", { length: 64 }).notNull(),
    keyVersion: varchar("key_version", { length: 80 }).notNull().default("v1"),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_broker_secret_payload_account").on(table.brokerAccountId),
  ],
);
