import assert from "node:assert/strict";
import test from "node:test";
import { loadDbConnection } from "./config";

test("loadDbConnection accepts host:port/db with DATABASE_USER_NAME/PASSWORD", () => {
  const cfg = loadDbConnection({
    DATABASE_URL: "database-1.example.rds.amazonaws.com:3306/auto_trading?ssl=false",
    DATABASE_USER_NAME: "root",
    DATABASE_PASSWORD: "secret-pass",
  });
  assert.ok(cfg);
  assert.equal(cfg.host, "database-1.example.rds.amazonaws.com");
  assert.equal(cfg.port, 3306);
  assert.equal(cfg.database, "auto_trading");
  assert.equal(cfg.user, "root");
  assert.equal(cfg.password, "secret-pass");
  assert.equal(cfg.ssl, false);
});

test("loadDbConnection mysql URL can fill missing user from DATABASE_USER_NAME", () => {
  const cfg = loadDbConnection({
    DATABASE_URL: "mysql://:secret@127.0.0.1:3306/auto_trading?ssl=false",
    DATABASE_USER_NAME: "app",
  });
  assert.ok(cfg);
  assert.equal(cfg.user, "app");
  assert.equal(cfg.password, "secret");
});
