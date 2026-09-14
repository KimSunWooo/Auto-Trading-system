import assert from "node:assert/strict";
import test from "node:test";
import { KisBroker } from "./KisBroker";
import { MockBroker } from "./MockBroker";
import { createInitialState } from "@/lib/engine";

test("KisBroker skeleton refuses live orders", async () => {
  const kis = new KisBroker();
  const fill = await kis.buyMarket("005930", 100000);
  assert.equal(fill.ok, false);
  assert.match(fill.reason ?? "", /연결되지/);
});

test("MockBroker getCurrentPrice reads the paper book", async () => {
  const box = { current: createInitialState() };
  const broker = new MockBroker(box, "Level1_Stable");
  const price = await broker.getCurrentPrice("005930");
  assert.ok(price > 0);
});
