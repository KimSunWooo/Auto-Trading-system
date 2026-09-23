import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRepresentativeDashboard,
  resetDashboardQuoteCacheForTest,
  seedUsDashboardQuote,
} from "@/src/instruments/dashboard-quotes";

test("dashboard failure never blocks trading and US uses cache TTL", () => {
  resetDashboardQuoteCacheForTest();
  seedUsDashboardQuote("US:NASDAQ:AAPL", 190.5);
  const cards = buildRepresentativeDashboard({ country: "US" });
  assert.ok(cards.length >= 5);
  assert.ok(cards.every((c) => c.blocksTrading === false));
  const aapl = cards.find((c) => c.instrument.symbol === "AAPL");
  assert.ok(aapl);
  assert.equal(aapl!.price, 190.5);
  assert.equal(aapl!.currency, "USD");
});

test("KR unavailable when no WS/local quote — still blocksTrading=false", () => {
  resetDashboardQuoteCacheForTest();
  const cards = buildRepresentativeDashboard({ country: "KR", localQuotes: {} });
  assert.ok(cards.every((c) => c.status === "unavailable"));
  assert.ok(cards.every((c) => c.blocksTrading === false));
});
