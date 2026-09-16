import { defineConfig } from "drizzle-kit";

/**
 * Introspection / generate only. Do not `drizzle-kit push` against production RDS.
 * Fresh local databases should load `db/baseline.mysql.sql`.
 */
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "mysql://autotrading_app:local@127.0.0.1:3307/auto_trading",
  },
});
