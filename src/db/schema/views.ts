import { char, datetime, decimal, mysqlView, varchar } from "drizzle-orm/mysql-core";

export const vBuyHistory = mysqlView("v_buy_history", {
  executionId: char("execution_id", { length: 36 }).notNull(),
  brokerAccountId: char("broker_account_id", { length: 36 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull(),
  orderId: char("order_id", { length: 36 }).notNull(),
  instrumentId: char("instrument_id", { length: 36 }).notNull(),
  country: char("country", { length: 2 }).notNull(),
  market: varchar("market", { length: 20 }).notNull(),
  symbol: varchar("symbol", { length: 32 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  quantity: decimal("quantity", { precision: 28, scale: 8, mode: "string" }).notNull(),
  price: decimal("price", { precision: 28, scale: 8, mode: "string" }).notNull(),
  grossAmount: decimal("gross_amount", { precision: 28, scale: 8, mode: "string" }).notNull(),
  commission: decimal("commission", { precision: 28, scale: 8, mode: "string" }).notNull(),
  tax: decimal("tax", { precision: 28, scale: 8, mode: "string" }).notNull(),
  otherFee: decimal("other_fee", { precision: 28, scale: 8, mode: "string" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  brokerOrderNo: varchar("broker_order_no", { length: 80 }),
  executedAt: datetime("executed_at", { fsp: 6, mode: "string" }).notNull(),
  createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
}).existing();
