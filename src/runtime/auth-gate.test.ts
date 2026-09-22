/**
 * Auth gate + runtime error mapping (no live orders).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError } from "@/src/auth/guards";
import {
  AccountNotConnectedError,
  runtimeJsonError,
} from "@/src/runtime/resolve-trading-runtime";
import { isAdminPresetUiEnabled, isLocalAdminHost } from "@/src/rules/admin-presets";

test("unauthenticated maps to 401", async () => {
  const res = runtimeJsonError(new AuthError(401, "Authentication required"));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "Authentication required");
});

test("no PAPER account maps to 409 ACCOUNT_NOT_CONNECTED", async () => {
  const res = runtimeJsonError(new AccountNotConnectedError());
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "ACCOUNT_NOT_CONNECTED");
});

test("ADMIN UI helpers never authorize via localhost or env flag", () => {
  assert.equal(isLocalAdminHost("localhost"), false);
  assert.equal(isAdminPresetUiEnabled("localhost", "true"), false);
  assert.equal(isAdminPresetUiEnabled("127.0.0.1", "true"), false);
});
