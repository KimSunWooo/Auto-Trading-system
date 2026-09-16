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

export const instruments = mysqlTable(
  "instruments",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    country: char("country", { length: 2 }).notNull(),
    market: varchar("market", { length: 20 }).notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    koreanName: varchar("korean_name", { length: 255 }),
    englishName: varchar("english_name", { length: 255 }),
    currency: char("currency", { length: 3 }).notNull(),
    kisExchangeCode: varchar("kis_exchange_code", { length: 20 }),
    instrumentType: varchar("instrument_type", { length: 20 }).notNull().default("STOCK"),
    isActive: boolean("is_active").notNull().default(true),
    listedAt: date("listed_at", { mode: "string" }),
    delistedAt: date("delisted_at", { mode: "string" }),
    masterUpdatedAt: datetime("master_updated_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_instruments_country_market").on(table.country, table.market, table.isActive),
    index("ix_instruments_name").on(table.displayName),
    index("ix_instruments_symbol").on(table.symbol),
    uniqueIndex("uq_instruments_identity").on(table.country, table.market, table.symbol),
  ],
);

export const instrumentAliases = mysqlTable(
  "instrument_aliases",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    instrumentId: char("instrument_id", { length: 36 }).notNull(),
    alias: varchar("alias", { length: 255 }).notNull(),
    normalizedAlias: varchar("normalized_alias", { length: 255 }).notNull(),
    aliasType: varchar("alias_type", { length: 20 }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_instrument_alias_search").on(table.normalizedAlias),
    uniqueIndex("uq_instrument_alias").on(table.instrumentId, table.normalizedAlias),
  ],
);

export const instrumentSyncRuns = mysqlTable(
  "instrument_sync_runs",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    country: char("country", { length: 2 }).notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    totalCount: int("total_count").notNull().default(0),
    insertedCount: int("inserted_count").notNull().default(0),
    updatedCount: int("updated_count").notNull().default(0),
    deactivatedCount: int("deactivated_count").notNull().default(0),
    warningJson: json("warning_json"),
    startedAt: datetime("started_at", { fsp: 6, mode: "string" }).notNull(),
    finishedAt: datetime("finished_at", { fsp: 6, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_instrument_sync_runs").on(table.country, table.startedAt),
  ],
);
