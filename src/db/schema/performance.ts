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

export const cashBalanceSnapshots = mysqlTable(
  "cash_balance_snapshots",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    cashBalance: decimal("cash_balance", { precision: 28, scale: 8, mode: "string" }).notNull(),
    orderableAmount: decimal("orderable_amount", { precision: 28, scale: 8, mode: "string" }).notNull(),
    withdrawableAmount: decimal("withdrawable_amount", { precision: 28, scale: 8, mode: "string" }),
    source: varchar("source", { length: 80 }).notNull(),
    capturedAt: datetime("captured_at", { fsp: 6, mode: "string" }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_cash_balance_account_currency_time").on(table.brokerAccountId, table.currency, table.capturedAt),
  ],
);

export const accountSnapshots = mysqlTable(
  "account_snapshots",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    totalAssetValue: decimal("total_asset_value", { precision: 28, scale: 8, mode: "string" }).notNull(),
    cashValue: decimal("cash_value", { precision: 28, scale: 8, mode: "string" }).notNull(),
    stockMarketValue: decimal("stock_market_value", { precision: 28, scale: 8, mode: "string" }).notNull(),
    realizedPnl: decimal("realized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    unrealizedPnl: decimal("unrealized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    capturedAt: datetime("captured_at", { fsp: 6, mode: "string" }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_account_snapshots_account_time").on(table.brokerAccountId, table.capturedAt),
  ],
);

export const equitySnapshots = mysqlTable(
  "equity_snapshots",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    equity: decimal("equity", { precision: 28, scale: 8, mode: "string" }).notNull(),
    cash: decimal("cash", { precision: 28, scale: 8, mode: "string" }).notNull(),
    marketValue: decimal("market_value", { precision: 28, scale: 8, mode: "string" }).notNull(),
    realizedPnl: decimal("realized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    unrealizedPnl: decimal("unrealized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    currency: char("currency", { length: 3 }).notNull(),
    capturedAt: datetime("captured_at", { fsp: 6, mode: "string" }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_equity_snapshots_account_time").on(table.brokerAccountId, table.capturedAt),
  ],
);

export const fxRateSnapshots = mysqlTable(
  "fx_rate_snapshots",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    quoteCurrency: char("quote_currency", { length: 3 }).notNull(),
    rate: decimal("rate", { precision: 28, scale: 8, mode: "string" }).notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    capturedAt: datetime("captured_at", { fsp: 6, mode: "string" }).notNull(),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    index("ix_fx_rate_pair_time").on(table.baseCurrency, table.quoteCurrency, table.capturedAt),
  ],
);

export const dailyPerformance = mysqlTable(
  "daily_performance",
  {
    id: char("id", { length: 36 }).primaryKey().notNull(),
    brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
    tradeDate: date("trade_date", { mode: "string" }).notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull(),
    startingEquity: decimal("starting_equity", { precision: 28, scale: 8, mode: "string" }).notNull(),
    endingEquity: decimal("ending_equity", { precision: 28, scale: 8, mode: "string" }).notNull(),
    realizedPnl: decimal("realized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    unrealizedPnl: decimal("unrealized_pnl", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    dailyReturnPct: decimal("daily_return_pct", { precision: 18, scale: 8, mode: "string" }),
    tradeCount: int("trade_count").notNull().default(0),
    winCount: int("win_count").notNull().default(0),
    lossCount: int("loss_count").notNull().default(0),
    grossProfit: decimal("gross_profit", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    grossLoss: decimal("gross_loss", { precision: 28, scale: 8, mode: "string" }).notNull().default("0.00000000"),
    maxDrawdown: decimal("max_drawdown", { precision: 18, scale: 8, mode: "string" }),
    createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull().default(sql`CURRENT_TIMESTAMP(6)`).$onUpdate(() => sql`CURRENT_TIMESTAMP(6)`),
  },
  (table) => [
    uniqueIndex("uq_daily_performance").on(table.brokerAccountId, table.tradeDate),
  ],
);
