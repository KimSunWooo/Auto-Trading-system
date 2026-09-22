/**
 * Project KIS WebSocket H0STCNT0 snapshots into AppState.quotes.
 * One-time REST seed for prevClose/name; daily history stays REST+cache.
 * Never fabricates prevClose from current price.
 */
import type { StateBox } from "@/src/accounts/StateBox";
import type { KisApi, KisClient, KisPrice } from "@/src/brokers/kis-client";
import { KisClient as KisClientClass } from "@/src/brokers/kis-client";
import type { Quote } from "@/lib/types";
import { findStock } from "@/lib/universe";
import { tickSize } from "@/lib/tick-size";
import { nowMs } from "@/src/clock";
import { LIVE_KIS_QUOTE_FRESH_MS } from "@/src/runtime/quote-policy";
import type { RealtimeQuoteHub, RealtimeQuoteSnapshot } from "@/src/market-data/kis-realtime-quote-hub";
import {
  acquireQuoteHub,
  dropQuoteHubRef,
  getQuoteHub,
} from "@/src/market-data/kis-realtime-registry";
import { kisCredentialSessionKey } from "@/src/market-data/kis-approval";

/** Process-local: tickers that already received one-time inquirePrice metadata seed. */
const metadataSeeded = new Set<string>();

/** Optional: count inquirePrice calls for telemetry/tests. */
let inquirePriceSeedCount = 0;

export function resetWsQuoteFeedForTest(): void {
  metadataSeeded.clear();
  inquirePriceSeedCount = 0;
}

export function inquirePriceSeedCountForTest(): number {
  return inquirePriceSeedCount;
}

export function isKisClient(client: KisApi): client is KisClient {
  return client instanceof KisClientClass;
}

/**
 * Acquire one hub reference for a RuntimeScope.
 * Always bumps registry refCount — callers must release exactly once on dispose.
 * Do NOT call from tick loops.
 */
export function acquirePaperQuoteHub(client: KisApi): RealtimeQuoteHub | null {
  if (!isKisClient(client)) return null;
  if (client.mode !== "paper" || !client.configured) return null;
  try {
    return acquireQuoteHub({ config: client.wsConfig() });
  } catch {
    return null;
  }
}

/**
 * Lookup existing hub without changing refCount.
 * Safe for tick fallback when deps.quoteHub was not injected.
 */
export function peekPaperQuoteHub(client: KisApi): RealtimeQuoteHub | null {
  if (!isKisClient(client)) return null;
  if (client.mode !== "paper" || !client.configured) return null;
  const cfg = client.wsConfig();
  const key = kisCredentialSessionKey(cfg.environment, cfg.appKey);
  return getQuoteHub(key) ?? null;
}

/**
 * @deprecated Use acquirePaperQuoteHub at scope create, peekPaperQuoteHub on tick.
 * Kept as alias to acquire for any remaining call sites during migration.
 */
export function resolvePaperQuoteHub(client: KisApi): RealtimeQuoteHub | null {
  return acquirePaperQuoteHub(client);
}

export async function ensureQuoteHubStarted(hub: RealtimeQuoteHub): Promise<void> {
  const h = hub.health();
  if (h.state === "CONNECTED" || h.state === "CONNECTING" || h.state === "RECONNECTING") {
    if (h.state === "CONNECTING" || h.state === "RECONNECTING") {
      try {
        await hub.start();
      } catch {
        /* reconnect scheduled inside hub */
      }
    }
    return;
  }
  try {
    await hub.start();
  } catch {
    /* fail-closed at call site via health() */
  }
}

/**
 * Sync WS subscriptions for one account/runtime consumer (Set diff via hub union).
 * Throws SubscriptionCapacityError when over limit.
 */
export async function syncWatchedSubscriptions(
  hub: RealtimeQuoteHub,
  consumerId: string,
  tickers: string[],
): Promise<void> {
  await ensureQuoteHubStarted(hub);
  await hub.syncSubscriptions(consumerId, tickers);
}

/** Drop one account's subscriptions from a shared hub without affecting peers. */
export async function clearConsumerWatchedSubscriptions(
  hub: RealtimeQuoteHub,
  consumerId: string,
): Promise<void> {
  await hub.clearConsumerSubscriptions(consumerId);
}

/** Dispose hub reference held by a RuntimeScope (ref-counted). Clears consumer first. */
export async function disposeScopeQuoteHub(
  hub: RealtimeQuoteHub | null | undefined,
  consumerId?: string,
): Promise<void> {
  if (!hub) return;
  if (consumerId) {
    try {
      await hub.clearConsumerSubscriptions(consumerId);
    } catch {
      /* ignore */
    }
  }
  await dropQuoteHubRef(hub);
}

export type WsQuoteRefreshResult = {
  ok: boolean;
  /** True when hub is CONNECTED. */
  connected: boolean;
  projected: number;
  missing: string[];
  stale: string[];
  inquirePriceSeeds: number;
};

/**
 * Pull fresh WS quotes into AppState. Does not call inquirePrice for current price.
 * May call inquirePrice once per ticker for prevClose/name seed only.
 * May call inquireDailyCloses for MA history (10 min cache inside client).
 */
export async function refreshQuotesFromWebSocket(
  box: StateBox,
  hub: RealtimeQuoteHub,
  client: KisApi,
  tickers: string[],
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<WsQuoteRefreshResult> {
  const now = opts.now ?? nowMs();
  const maxAgeMs = opts.maxAgeMs ?? LIVE_KIS_QUOTE_FRESH_MS;
  const health = hub.health();
  const connected = health.connected;

  if (tickers.length === 0) {
    return { ok: true, connected, projected: 0, missing: [], stale: [], inquirePriceSeeds: 0 };
  }

  if (!connected) {
    return {
      ok: false,
      connected: false,
      projected: 0,
      missing: [...tickers],
      stale: [],
      inquirePriceSeeds: 0,
    };
  }

  let projected = 0;
  let seeds = 0;
  const missing: string[] = [];
  const stale: string[] = [];
  const nextQuotes = { ...box.current.quotes };

  for (const code of tickers) {
    const snap = hub.get(code);
    if (!snap || !(snap.price > 0)) {
      missing.push(code);
      continue;
    }
    if (now - snap.receivedAt > maxAgeMs) {
      stale.push(code);
      continue;
    }

    const prev = nextQuotes[code];
    let prevClose = prev?.prevClose && prev.prevClose > 0 ? prev.prevClose : 0;
    let name = prev?.name || findStock(code)?.name || code;
    let history = prev?.history ?? [];

    if (!metadataSeeded.has(code) || !(prevClose > 0)) {
      const seeded = await seedMetadataOnce(client, code);
      if (seeded) {
        seeds += 1;
        if (seeded.prevClose > 0) prevClose = seeded.prevClose;
        if (seeded.name) name = seeded.name;
        if (!(prevClose > 0) && seeded.open > 0) {
          // still do not fabricate from current WS price
        }
      }
      metadataSeeded.add(code);
    }

    try {
      const daily = await client.inquireDailyCloses(code);
      if (daily.length > 0) {
        history = [...daily.slice(-39), snap.price];
      } else if (history.length > 0) {
        history = [...history.slice(-39), snap.price];
      } else {
        history = [snap.price];
      }
    } catch {
      if (history.length > 0) {
        history = [...history.slice(-39), snap.price];
      } else {
        history = [snap.price];
      }
    }

    // prevClose must come from verified seed/prior snapshot — never WS current price.
    if (!(prevClose > 0) && prev?.source === "kis" && prev.prevClose > 0) {
      prevClose = prev.prevClose;
    }

    const tick = tickSize(snap.price);
    const quote: Quote = {
      code,
      name,
      market: prev?.market ?? findStock(code)?.market ?? "KOSPI",
      price: snap.price,
      prevClose: prevClose > 0 ? prevClose : 0,
      open: snap.open || snap.price,
      high: snap.high || snap.price,
      low: snap.low || snap.price,
      volume: snap.volume,
      bid: snap.bid > 0 ? snap.bid : Math.max(tick, snap.price - tick),
      ask: snap.ask > 0 ? snap.ask : snap.price + tick,
      history,
      source: "kis",
      transport: "ws",
      freshAt: snap.receivedAt,
    };
    nextQuotes[code] = quote;
    projected += 1;
  }

  box.current = { ...box.current, quotes: nextQuotes };
  const ok = missing.length === 0 && stale.length === 0 && projected === tickers.length;
  return { ok, connected, projected, missing, stale, inquirePriceSeeds: seeds };
}

async function seedMetadataOnce(client: KisApi, ticker: string): Promise<KisPrice | null> {
  try {
    inquirePriceSeedCount += 1;
    return await client.inquirePrice(ticker);
  } catch {
    return null;
  }
}

/** Map hub snapshot → BrokerQuote fields for order path helpers. */
export function brokerQuoteFromSnapshot(
  snap: RealtimeQuoteSnapshot,
  prev: Quote | undefined,
): {
  ticker: string;
  name: string;
  price: number;
  bid: number;
  ask: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  history: number[];
} {
  const tick = tickSize(snap.price);
  return {
    ticker: snap.ticker,
    name: prev?.name || findStock(snap.ticker)?.name || snap.ticker,
    price: snap.price,
    bid: snap.bid > 0 ? snap.bid : Math.max(tick, snap.price - tick),
    ask: snap.ask > 0 ? snap.ask : snap.price + tick,
    open: snap.open || snap.price,
    high: snap.high || snap.price,
    low: snap.low || snap.price,
    prevClose: prev?.prevClose && prev.prevClose > 0 ? prev.prevClose : 0,
    volume: snap.volume,
    history: prev?.history?.length
      ? [...prev.history.slice(-39), snap.price]
      : [snap.price],
  };
}
