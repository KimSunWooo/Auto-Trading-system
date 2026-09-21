/**
 * Regression: overseas adapter unit paths must not mutate production JSON ledgers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createPaperState } from "@/lib/engine";
import { KisClient } from "@/src/brokers/kis-client";
import { BrokerRejectError } from "@/src/risk/errors";
import { OverseasTradingAdapter } from "@/src/markets/overseas/adapter";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { DEFAULT_STORE_PATH } from "@/lib/store";
import { isNodeTestProcess } from "@/src/runtime/test-process";

const STRATEGY_PATH = path.join(process.cwd(), "data", "strategy-config.json");

function sha256File(filePath: string): string {
  if (!existsSync(filePath)) return "MISSING";
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

afterEach(() => {
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
});

test("isNodeTestProcess detects *.test.ts worker argv", () => {
  assert.equal(isNodeTestProcess({ MIRAEMAESU_TEST: "1" }, []), true);
  assert.equal(
    isNodeTestProcess({}, ["node", "src/runtime/vts-harness.test.ts"]),
    true,
  );
  assert.equal(isNodeTestProcess({}, ["node", "scripts/overseas-paper-server-ready.ts"]), false);
});

test("Test P1: overseas persist-before-POST unit path leaves production JSON unchanged", async () => {
  const beforeAccount = sha256File(DEFAULT_STORE_PATH);
  const beforeStrategy = sha256File(STRATEGY_PATH);
  process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS = "true";

  let persistCount = 0;
  let postCount = 0;
  const adapter = new OverseasTradingAdapter(
    {
      orderOverseasUs: async () => {
        postCount += 1;
        throw new BrokerRejectError("unit-reject");
      },
    } as unknown as KisClient,
    {
      persistState: async () => {
        persistCount += 1;
      },
    },
  );
  const box = { current: createPaperState() };
  await adapter.submitLimitOnce(box, {
    intentId: "sig:ov:pollution-guard",
    signalId: "sig:ov:pollution-guard",
    instrument: makeUsInstrument("NYSE", "F"),
    side: "buy",
    qty: 1,
    price: 11.25,
    orderableUsd: 100,
    refreshBuyingPower: false,
  });

  assert.equal(postCount, 1);
  assert.ok(persistCount >= 1, "persist-before-POST must still run");
  assert.equal(sha256File(DEFAULT_STORE_PATH), beforeAccount);
  assert.equal(sha256File(STRATEGY_PATH), beforeStrategy);
  assert.equal(
    JSON.stringify(JSON.parse(readFileSync(DEFAULT_STORE_PATH, "utf8")).intents ?? []).includes(
      "sig:ov:pollution-guard",
    ),
    false,
  );
});
