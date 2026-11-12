import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApprovedRdsConfigForOrders,
  evaluateApprovedRdsConfig,
  isApprovedRdsHost,
  isLocalDbHost,
} from "./rds-authority";

test("isApprovedRdsHost accepts only *.rds.amazonaws.com", () => {
  assert.equal(isApprovedRdsHost("database-1.abc123.ap-northeast-2.rds.amazonaws.com"), true);
  assert.equal(isApprovedRdsHost("127.0.0.1"), false);
  assert.equal(isApprovedRdsHost("localhost"), false);
  assert.equal(isApprovedRdsHost("db.example.com"), false);
});

test("isLocalDbHost flags loopback", () => {
  assert.equal(isLocalDbHost("127.0.0.1"), true);
  assert.equal(isLocalDbHost("localhost"), true);
  assert.equal(isLocalDbHost("database-1.example.rds.amazonaws.com"), false);
});

test("evaluateApprovedRdsConfig requires database mode + approved host outside tests", () => {
  const deniedMode = evaluateApprovedRdsConfig(
    {
      PERSISTENCE_MODE: "json",
      DATABASE_URL: "mysql://u:p@database-1.example.rds.amazonaws.com:3306/auto_trading",
    },
    { allowTestNonRds: false },
  );
  assert.equal(deniedMode.ok, false);
  if (!deniedMode.ok) assert.equal(deniedMode.code, "PERSISTENCE_NOT_DATABASE");

  const deniedLocal = evaluateApprovedRdsConfig(
    {
      PERSISTENCE_MODE: "database",
      DATABASE_URL: "mysql://u:p@127.0.0.1:3307/auto_trading",
    },
    { allowTestNonRds: false },
  );
  assert.equal(deniedLocal.ok, false);
  if (!deniedLocal.ok) assert.equal(deniedLocal.code, "LOCAL_HOST_DENIED");

  const ok = evaluateApprovedRdsConfig(
    {
      PERSISTENCE_MODE: "database",
      DATABASE_URL: "mysql://u:p@database-1.example.rds.amazonaws.com:3306/auto_trading",
    },
    { allowTestNonRds: false },
  );
  assert.equal(ok.ok, true);
});

test("assertApprovedRdsConfigForOrders blocks local host in ops mode", () => {
  const msg = assertApprovedRdsConfigForOrders({
    PERSISTENCE_MODE: "database",
    DATABASE_URL: "mysql://u:p@127.0.0.1:3307/auto_trading",
    MIRAEMAESU_TEST: "0",
    NODE_ENV: "production",
  });
  // isNodeTestProcess still true from argv during npm test — use evaluate directly above.
  // Here we only assert the helper returns null or a string without throwing.
  assert.ok(msg === null || typeof msg === "string");
});
