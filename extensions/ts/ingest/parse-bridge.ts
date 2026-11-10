/**
 * Bridge to trading-core H0STCNT0 parser without adding runtime deps to core.
 * Fixture frames preferred until WS session sharing impact is measured.
 */
import { createHash } from "node:crypto";
import {
  parseH0stCnt0RealtimeBatch,
  type ParsedH0stCnt0,
} from "../../../src/market-data/h0stcnt0.ts";
import type { MarketEvent, OrderBookEvent, TradeEvent } from "../shared/types.ts";

let versionSeq = 0;

function nextVersion(): number {
  versionSeq += 1;
  return versionSeq;
}

function eventId(parts: Array<string | number>): string {
  const raw = parts.join("|");
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 16);
  return `${parts[0]}:${parts[1]}:${parts[2]}:${hash}`;
}

function exchangeTsMs(row: ParsedH0stCnt0, receivedTsMs: number): number {
  // BSOP_DATE YYYYMMDD + STCK_CNTG_HOUR HHMMSS — best effort; fall back to receive time.
  const date = row.fields.BSOP_DATE ?? "";
  const tod = row.tradeTime || row.fields.STCK_CNTG_HOUR || "";
  if (/^\d{8}$/.test(date) && /^\d{6}/.test(tod)) {
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${tod.slice(0, 2)}:${tod.slice(2, 4)}:${tod.slice(4, 6)}+09:00`;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  return receivedTsMs;
}

export function tradeFromH0stCnt0(row: ParsedH0stCnt0, receivedTsMs = Date.now()): TradeEvent {
  const exchange = exchangeTsMs(row, receivedTsMs);
  const version = nextVersion();
  return {
    partitionKey: `KR:${row.ticker}`,
    eventId: eventId(["TRADE", "KR", row.ticker, exchange, row.tradeVolume, row.price, version]),
    schemaVersion: "market-event.v1",
    kind: "TRADE",
    market: "KR",
    symbol: row.ticker,
    exchangeTsMs: exchange,
    receivedTsMs,
    version,
    price: row.price,
    tradeVolume: row.tradeVolume,
    bid: row.bid > 0 ? row.bid : undefined,
    ask: row.ask > 0 ? row.ask : undefined,
  };
}

/**
 * PAPER H0STASP0 is not verified in this repo — build a disabled ORDERBOOK
 * stub from H0STCNT0 top-of-book fields only, marked paperUnverified.
 */
export function orderBookStubFromH0stCnt0(
  row: ParsedH0stCnt0,
  receivedTsMs = Date.now(),
): OrderBookEvent {
  const exchange = exchangeTsMs(row, receivedTsMs);
  const version = nextVersion();
  const bidQty = Number(row.fields.BIDP_RSQN1 ?? 0) || 0;
  const askQty = Number(row.fields.ASKP_RSQN1 ?? 0) || 0;
  return {
    partitionKey: `KR:${row.ticker}`,
    eventId: eventId(["ORDERBOOK", "KR", row.ticker, exchange, version]),
    schemaVersion: "market-event.v1",
    kind: "ORDERBOOK",
    market: "KR",
    symbol: row.ticker,
    exchangeTsMs: exchange,
    receivedTsMs,
    version,
    bids: row.bid > 0 ? [{ price: row.bid, qty: bidQty }] : [],
    asks: row.ask > 0 ? [{ price: row.ask, qty: askQty }] : [],
    paperUnverified: true,
  };
}

export function parseRealtimeFramesToEvents(
  raw: string,
  receivedTsMs = Date.now(),
  opts: { emitOrderBookStub?: boolean } = {},
): { events: MarketEvent[]; parseErrors: number } {
  const batch = parseH0stCnt0RealtimeBatch(raw);
  const events: MarketEvent[] = [];
  for (const row of batch.rows) {
    if (!(row.price > 0)) continue;
    events.push(tradeFromH0stCnt0(row, receivedTsMs));
    if (opts.emitOrderBookStub) {
      events.push(orderBookStubFromH0stCnt0(row, receivedTsMs));
    }
  }
  return { events, parseErrors: batch.malformedRows };
}
