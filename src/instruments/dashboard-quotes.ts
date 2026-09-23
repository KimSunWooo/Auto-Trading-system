/**
 * Representative dashboard quotes — Priority 3.
 * Never opens trading circuit. Never evicts execution subscriptions.
 * Domestic: use in-memory WS cache if already present; otherwise stale/unavailable.
 * US: REST/cache with 45s TTL via PAPER scheduler path when available.
 */
import { configDashboardRepresentatives } from "@/src/instruments/dashboard";
import type { InstrumentRef } from "@/src/instruments/types";
import { peekPaperQuoteHub } from "@/src/market-data/ws-quote-feed";
import type { KisApi } from "@/src/brokers/kis-client";

export type DashboardQuoteCard = {
  instrument: InstrumentRef;
  price: number | null;
  currency: string;
  status: "live" | "stale" | "unavailable";
  source: "ws" | "rest-cache" | "none";
  freshAt?: number;
  /** Dashboard failure never blocks trading. */
  blocksTrading: false;
};

const US_CACHE_TTL_MS = 45_000;
const usQuoteCache = new Map<string, { price: number; freshAt: number }>();

export function resetDashboardQuoteCacheForTest(): void {
  usQuoteCache.clear();
}

export function buildRepresentativeDashboard(opts: {
  country?: "KR" | "US" | string;
  kisClient?: KisApi | null;
  /** Optional AppState quotes for domestic display only (no new subscribe). */
  localQuotes?: Record<string, { price: number; freshAt?: number; source?: string }>;
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
          currency: "KRW",
          status: age <= 15_000 ? "live" : "stale",
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
          currency: "KRW",
          status: age <= 15_000 ? "live" : "stale",
          source: "ws" as const,
          freshAt: local.freshAt,
          blocksTrading: false as const,
        };
      }
      return {
        instrument,
        price: null,
        currency: "KRW",
        status: "unavailable",
        source: "none",
        blocksTrading: false,
      };
    }

    // US / overseas — REST cache only (no forced WS).
    const cached = usQuoteCache.get(instrument.instrumentKey);
    if (cached && now - cached.freshAt <= US_CACHE_TTL_MS) {
      return {
        instrument,
        price: cached.price,
        currency: "USD",
        status: "live",
        source: "rest-cache",
        freshAt: cached.freshAt,
        blocksTrading: false,
      };
    }
    return {
      instrument,
      price: cached?.price ?? null,
      currency: "USD",
      status: cached ? "stale" : "unavailable",
      source: cached ? "rest-cache" : "none",
      freshAt: cached?.freshAt,
      blocksTrading: false,
    };
  });
}

/** Preflight/test helper: seed US cache without placing orders. */
export function seedUsDashboardQuote(instrumentKey: string, price: number, freshAt = Date.now()): void {
  usQuoteCache.set(instrumentKey, { price, freshAt });
}
