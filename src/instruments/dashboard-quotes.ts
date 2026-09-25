/**
 * Representative dashboard quotes — Priority 3.
 * Uses RuntimeScope-owned hub + dashboard:<accountId> consumer.
 * Never opens trading circuit. Never evicts execution subscriptions.
 */
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";
import type { InstrumentRef } from "@/src/instruments/types";
import { peekPaperQuoteHub } from "@/src/market-data/ws-quote-feed";
import { dashboardConsumerId, previewConsumerId } from "@/src/market-data/quote-priority";
import type { KisApi } from "@/src/brokers/kis-client";

export type DashboardQuoteCard = {
  instrument: InstrumentRef;
  price: number | null;
  bid: number | null;
  ask: number | null;
  currency: string;
  status: "live" | "stale" | "unavailable";
  source: "ws" | "rest-cache" | "none";
  freshAt?: number;
  /** Dashboard failure never blocks trading. */
  blocksTrading: false;
};

const US_CACHE_TTL_MS = 45_000;
const usQuoteCache = new Map<string, { price: number; freshAt: number }>();

/** Track which accounts already synced dashboard consumers this process (avoid re-acquire). */
const dashboardSynced = new Set<string>();

export function resetDashboardQuoteCacheForTest(): void {
  usQuoteCache.clear();
  dashboardSynced.clear();
}

/**
 * Sync KR representative tickers onto the existing RuntimeScope hub.
 * Does NOT acquire a new hub ref — uses peek only.
 */
export async function ensureDashboardSubscriptions(opts: {
  brokerAccountId: string;
  kisClient?: KisApi | null;
  country?: string;
}): Promise<{ consumerId: string; tickers: string[]; synced: boolean }> {
  const consumerId = dashboardConsumerId(opts.brokerAccountId);
  const tickers = configDashboardRepresentatives(opts.country ?? "KR")
    .filter((row) => row.country === "KR")
    .map((row) => row.symbol);
  const hub = opts.kisClient ? peekPaperQuoteHub(opts.kisClient) : null;
  if (!hub) {
    return { consumerId, tickers, synced: false };
  }
  try {
    await hub.syncSubscriptions(consumerId, tickers);
    dashboardSynced.add(opts.brokerAccountId);
    return { consumerId, tickers, synced: true };
  } catch {
    // Soft-fail — never block trading.
    return { consumerId, tickers, synced: false };
  }
}

/** Preview consumer: exactly one selected domestic ticker (or clear). */
export async function syncPreviewSubscription(opts: {
  brokerAccountId: string;
  kisClient?: KisApi | null;
  ticker?: string | null;
}): Promise<{ consumerId: string; synced: boolean }> {
  const consumerId = previewConsumerId(opts.brokerAccountId);
  const hub = opts.kisClient ? peekPaperQuoteHub(opts.kisClient) : null;
  if (!hub) return { consumerId, synced: false };
  const tickers =
    opts.ticker && /^\d{6}$/.test(opts.ticker) ? [opts.ticker] : [];
  try {
    await hub.syncSubscriptions(consumerId, tickers);
    return { consumerId, synced: true };
  } catch {
    return { consumerId, synced: false };
  }
}

export function buildRepresentativeDashboard(opts: {
  country?: "KR" | "US" | string;
  kisClient?: KisApi | null;
  /** Optional AppState quotes for domestic display only. */
  localQuotes?: Record<
    string,
    { price: number; bid?: number; ask?: number; freshAt?: number; source?: string }
  >;
  now?: number;
}): DashboardQuoteCard[] {
  const now = opts.now ?? Date.now();
  const reps = configDashboardRepresentatives(opts.country);
  const hub = opts.kisClient ? peekPaperQuoteHub(opts.kisClient) : null;

  return reps.map((instrument) => {
    if (instrument.country === "KR") {
      const local = opts.localQuotes?.[instrument.symbol];
      const snap = hub?.get(instrument.symbol) ?? null;
      if (snap && snap.price > 0) {
        const age = now - snap.receivedAt;
        return {
          instrument,
          price: snap.price,
          bid: snap.bid > 0 ? snap.bid : null,
          ask: snap.ask > 0 ? snap.ask : null,
          currency: "KRW",
          status: age <= 15_000 ? ("live" as const) : ("stale" as const),
          source: "ws" as const,
          freshAt: snap.receivedAt,
          blocksTrading: false as const,
        };
      }
      if (local && local.price > 0 && local.source === "kis") {
        const age = local.freshAt != null ? now - local.freshAt : Number.POSITIVE_INFINITY;
        return {
          instrument,
          price: local.price,
          bid: local.bid && local.bid > 0 ? local.bid : null,
          ask: local.ask && local.ask > 0 ? local.ask : null,
          currency: "KRW",
          status: age <= 15_000 ? ("live" as const) : ("stale" as const),
          source: "ws" as const,
          freshAt: local.freshAt,
          blocksTrading: false as const,
        };
      }
      return {
        instrument,
        price: null,
        bid: null,
        ask: null,
        currency: "KRW",
        status: "unavailable" as const,
        source: "none" as const,
        blocksTrading: false as const,
      };
    }

    const cached = usQuoteCache.get(instrument.instrumentKey);
    if (cached && now - cached.freshAt <= US_CACHE_TTL_MS) {
      return {
        instrument,
        price: cached.price,
        bid: null,
        ask: null,
        currency: "USD",
        status: "live" as const,
        source: "rest-cache" as const,
        freshAt: cached.freshAt,
        blocksTrading: false as const,
      };
    }
    return {
      instrument,
      price: cached?.price ?? null,
      bid: null,
      ask: null,
      currency: "USD",
      status: cached ? ("stale" as const) : ("unavailable" as const),
      source: cached ? ("rest-cache" as const) : ("none" as const),
      freshAt: cached?.freshAt,
      blocksTrading: false as const,
    };
  });
}

/** Preflight/test helper: seed US cache without placing orders. */
export function seedUsDashboardQuote(instrumentKey: string, price: number, freshAt = Date.now()): void {
  usQuoteCache.set(instrumentKey, { price, freshAt });
}
