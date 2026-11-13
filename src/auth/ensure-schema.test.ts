import assert from "node:assert/strict";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { ensureAuthSchema } from "./ensure-schema";

test("auth schema preparation is shared across callers and retries after failure", async (t) => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "mysql://test:test@schema-test.invalid:3306/test";
  t.after(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });
  const query = t.mock.fn(async (sql: string) => [
    sql.includes("SELECT id FROM broker_accounts") ? [] : [{}],
  ]);
  let attempts = 0;
  const connect = t.mock.method(mysql, "createConnection", async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection failed");
    return { query, end: async () => {} };
  });

  const first = ensureAuthSchema();
  assert.equal(first, ensureAuthSchema());
  await assert.rejects(first, /connection failed/);
  const retry = ensureAuthSchema();
  await Promise.all([retry, ensureAuthSchema()]);
  await ensureAuthSchema();
  assert.equal(connect.mock.callCount(), 2);
  assert.equal(query.mock.calls.filter(({ arguments: [sql] }) => sql.includes("UPDATE users u")).length, 3);
});
