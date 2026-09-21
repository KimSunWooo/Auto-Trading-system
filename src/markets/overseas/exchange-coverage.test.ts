import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeOverseasPositionsByIdentity,
  mergeOverseasOpenOrdersByOdno,
  positionCoverageByExchange,
  collectAllExchangePositions,
  collectAllExchangeOpenOrders,
  allExchangeProbesOk,
} from "@/src/markets/overseas/exchange-coverage";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import type { OverseasOpenOrder, OverseasPosition } from "@/src/markets/overseas/types";

function pos(exchange: "NASDAQ" | "NYSE" | "AMEX", symbol: string, qty = 1): OverseasPosition {
  const instrument = makeUsInstrument(exchange, symbol);
  return {
    identity: `${exchange}:${symbol}`,
    instrument,
    qty,
    avgPrice: 10,
    last: 10,
    marketValue: 10 * qty,
    currency: "USD",
    krwEquivalent: null,
  };
}

function open(
  exchange: "NASDAQ" | "NYSE" | "AMEX",
  symbol: string,
  orderNo: string,
): OverseasOpenOrder {
  return {
    orderNo,
    identity: `${exchange}:${symbol}`,
    symbol,
    exchange,
    side: "buy",
    qty: 1,
    filledQty: 0,
    remainingQty: 1,
    price: 10,
    currency: "USD",
  };
}

test("Test I/J/K: NASDAQ/NYSE/AMEX position sync coverage counts", () => {
  const rows = [pos("NASDAQ", "AAPL"), pos("NYSE", "F"), pos("AMEX", "SPY")];
  const coverage = positionCoverageByExchange(rows);
  assert.equal(coverage.NASDAQ, 1);
  assert.equal(coverage.NYSE, 1);
  assert.equal(coverage.AMEX, 1);
});

test("Test L: multiple exchange positions merge without duplicate identity", () => {
  const merged = mergeOverseasPositionsByIdentity([
    pos("NASDAQ", "AAPL", 1),
    pos("NASDAQ", "AAPL", 1),
    pos("NYSE", "F", 2),
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.identity === "NASDAQ:AAPL"));
  assert.ok(merged.some((r) => r.identity === "NYSE:F" && r.qty === 2));
});

test("Test M: same symbol different exchange identity preserved", () => {
  const merged = mergeOverseasPositionsByIdentity([
    pos("NASDAQ", "ABC"),
    pos("NYSE", "ABC"),
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.identity === "NASDAQ:ABC"));
  assert.ok(merged.some((r) => r.identity === "NYSE:ABC"));
});

test("open orders de-dupe by ODNO across exchanges", () => {
  const merged = mergeOverseasOpenOrdersByOdno([
    open("NASDAQ", "AAPL", "111"),
    open("NASDAQ", "AAPL", "111"),
    open("NYSE", "F", "222"),
  ]);
  assert.equal(merged.length, 2);
});

test("collectAllExchangePositions probes every US exchange", async () => {
  const seen: string[] = [];
  const { positions, probes } = await collectAllExchangePositions(async (exchange) => {
    seen.push(exchange);
    if (exchange === "NYSE") return [pos("NYSE", "F")];
    return [];
  });
  assert.deepEqual(seen, ["NASDAQ", "NYSE", "AMEX"]);
  assert.equal(allExchangeProbesOk(probes), true);
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.identity, "NYSE:F");
});

test("collectAllExchangeOpenOrders continues when one exchange fails", async () => {
  const { orders, probes } = await collectAllExchangeOpenOrders(async (exchange) => {
    if (exchange === "AMEX") throw new Error("rate limit");
    if (exchange === "NASDAQ") return [open("NASDAQ", "AAPL", "1")];
    return [];
  });
  assert.equal(orders.length, 1);
  assert.equal(allExchangeProbesOk(probes), false);
  assert.equal(probes.find((p) => p.exchange === "AMEX")?.ok, false);
});
