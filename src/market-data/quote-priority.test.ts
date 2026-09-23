import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dashboardConsumerId,
  executionConsumerId,
  isLowPriorityConsumer,
  previewConsumerId,
} from "@/src/market-data/quote-priority";

test("WS5 low-priority consumer ids are distinguishable from execution", () => {
  const account = "acct-1";
  assert.equal(executionConsumerId(account), "acct-1");
  assert.equal(isLowPriorityConsumer(executionConsumerId(account)), false);
  assert.equal(isLowPriorityConsumer(dashboardConsumerId(account)), true);
  assert.equal(isLowPriorityConsumer(previewConsumerId(account)), true);
});
