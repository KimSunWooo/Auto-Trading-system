/**
 * Ownership DB gate — fake connectors only. Never opens a real MySQL/RDS socket.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbConnectionConfig } from "@/src/db/config";
import {
  PAPER_OWNERSHIP_DB_TESTS_FLAG,
  PAPER_OWNERSHIP_TEST_DB_NAME,
  connectOnlyIfPaperOwnershipDbAllowed,
  evaluatePaperOwnershipDbAccess,
} from "@/src/auth/paper-ownership-db-guard";

function localTestCfg(over: Partial<DbConnectionConfig> = {}): DbConnectionConfig {
  return {
    host: "127.0.0.1",
    port: 3307,
    user: "autotrading_app",
    password: "local",
    database: PAPER_OWNERSHIP_TEST_DB_NAME,
    ssl: false,
    ...over,
  };
}

const flagOn = { [PAPER_OWNERSHIP_DB_TESTS_FLAG]: "1", BROKER_CREDENTIAL_MASTER_KEY: "unit-test-master-key-32chars-min!!" };

test("G1 allowed localhost + dedicated DB + flag → ok (no connect yet)", () => {
  const access = evaluatePaperOwnershipDbAccess(localTestCfg(), flagOn);
  assert.equal(access.ok, true);
  if (access.ok) {
    assert.equal(access.database, PAPER_OWNERSHIP_TEST_DB_NAME);
    assert.equal(access.host, "127.0.0.1");
  }
});

test("G2 flag off → deny before connect", () => {
  let connects = 0;
  const { access, connection } = connectOnlyIfPaperOwnershipDbAllowed(
    localTestCfg(),
    { BROKER_CREDENTIAL_MASTER_KEY: "unit-test-master-key-32chars-min!!" },
    () => {
      connects += 1;
      return { kind: "fake" };
    },
  );
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, "FLAG_OFF");
  assert.equal(connection, null);
  assert.equal(connects, 0);
});

test("G3 ops-looking RDS host → deny; createConnection never called", () => {
  let connects = 0;
  const opsHost = "database-1.example.rds.amazonaws.com";
  const { access, connection } = connectOnlyIfPaperOwnershipDbAllowed(
    localTestCfg({ host: opsHost, database: "auto_trading" }),
    flagOn,
    () => {
      connects += 1;
      return { query: async () => [], end: async () => undefined };
    },
  );
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, "HOST_DENIED");
  assert.equal(connection, null);
  assert.equal(connects, 0);
  // Reason must not echo password / full URL secrets.
  if (!access.ok) {
    assert.equal(/password|secret|AKIA/i.test(access.reason), false);
  }
});

test("G4 localhost but production DB name auto_trading → deny", () => {
  let connects = 0;
  const { access, connection } = connectOnlyIfPaperOwnershipDbAllowed(
    localTestCfg({ database: "auto_trading" }),
    flagOn,
    () => {
      connects += 1;
      return { kind: "fake" };
    },
  );
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, "DB_NAME_DENIED");
  assert.equal(connection, null);
  assert.equal(connects, 0);
});

test("G5 missing master key → deny", () => {
  const access = evaluatePaperOwnershipDbAccess(localTestCfg(), {
    [PAPER_OWNERSHIP_DB_TESTS_FLAG]: "1",
  });
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, "MASTER_KEY_MISSING");
});

test("G6 null config → deny; factory does not connect", () => {
  let connects = 0;
  const { access, connection } = connectOnlyIfPaperOwnershipDbAllowed(null, flagOn, () => {
    connects += 1;
    return { kind: "fake" };
  });
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, "NOT_CONFIGURED");
  assert.equal(connection, null);
  assert.equal(connects, 0);
});

test("G7 allowed path invokes createConnection exactly once with same cfg", () => {
  const cfg = localTestCfg();
  let connects = 0;
  let seenHost = "";
  let seenDb = "";
  const { access, connection } = connectOnlyIfPaperOwnershipDbAllowed(cfg, flagOn, (allowed) => {
    connects += 1;
    seenHost = allowed.host;
    seenDb = allowed.database;
    return { kind: "fake-ok" as const };
  });
  assert.equal(access.ok, true);
  assert.equal(connects, 1);
  assert.equal(connection?.kind, "fake-ok");
  assert.equal(seenHost, cfg.host);
  assert.equal(seenDb, PAPER_OWNERSHIP_TEST_DB_NAME);
});
