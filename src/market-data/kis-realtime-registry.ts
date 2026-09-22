/**
 * AppKey-scoped KIS WebSocket session registry.
 * Same AppKey → one WebSocket. Different AppKey → separate session.
 * Account state / orders / balance are never shared through this registry.
 */
import type { KisConfig } from "@/src/brokers/kis-config";
import { kisCredentialSessionKey, type ApprovalFetch } from "@/src/market-data/kis-approval";
import {
  KisRealtimeQuoteHub,
  type KisRealtimeQuoteHubOpts,
  type RealtimeQuoteHub,
  type WebSocketFactory,
} from "@/src/market-data/kis-realtime-quote-hub";

type RegistryEntry = {
  hub: KisRealtimeQuoteHub;
  refCount: number;
  appKeyFingerprint: string;
};

const registry = new Map<string, RegistryEntry>();

export type AcquireQuoteHubOpts = {
  config: Pick<KisConfig, "environment" | "appKey" | "appSecret" | "host" | "websocketUrl">;
  fetchImpl?: ApprovalFetch;
  webSocketFactory?: WebSocketFactory;
  hubOpts?: Partial<Omit<KisRealtimeQuoteHubOpts, "config" | "fetchImpl" | "webSocketFactory">>;
};

/** Acquire a shared hub for this AppKey. Call releaseQuoteHub when scope disposes. */
export function acquireQuoteHub(opts: AcquireQuoteHubOpts): RealtimeQuoteHub {
  if (opts.config.environment === "real") {
    throw new Error("REAL WebSocket is locked; PAPER domestic only");
  }
  const sessionKey = kisCredentialSessionKey(opts.config.environment, opts.config.appKey);
  const existing = registry.get(sessionKey);
  if (existing) {
    existing.refCount += 1;
    return existing.hub;
  }
  const hub = new KisRealtimeQuoteHub({
    config: opts.config,
    fetchImpl: opts.fetchImpl,
    webSocketFactory: opts.webSocketFactory,
    ...opts.hubOpts,
  });
  registry.set(sessionKey, {
    hub,
    refCount: 1,
    appKeyFingerprint: sessionKey,
  });
  return hub;
}

/** Release one RuntimeScope reference. Closes socket only when last ref drops. */
export async function releaseQuoteHub(sessionKeyOrHub: string | RealtimeQuoteHub): Promise<void> {
  const key =
    typeof sessionKeyOrHub === "string" ? sessionKeyOrHub : sessionKeyOrHub.sessionKey;
  const entry = registry.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  registry.delete(key);
  await entry.hub.stop();
}

export function getQuoteHub(sessionKey: string): RealtimeQuoteHub | undefined {
  return registry.get(sessionKey)?.hub;
}

export function quoteHubRegistrySize(): number {
  return registry.size;
}

export function quoteHubRefCount(sessionKey: string): number {
  return registry.get(sessionKey)?.refCount ?? 0;
}

/** Test / shutdown: stop all hubs. */
export async function resetQuoteHubRegistry(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(entries.map((e) => e.hub.stop()));
}
