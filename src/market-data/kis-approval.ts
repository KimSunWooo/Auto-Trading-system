/**
 * KIS WebSocket approval_key client.
 * POST /oauth2/Approval with grant_type=client_credentials, appkey, secretkey.
 * Never log approval_key, appkey, or appsecret.
 */
import { createHash } from "node:crypto";
import type { KisConfig, KisEnvironment } from "@/src/brokers/kis-config";
import { KIS_HOSTS } from "@/src/brokers/kis-config";

/** Secret-free session identity: environment + hashed appKey. */
export function kisCredentialSessionKey(
  environment: KisEnvironment,
  appKey: string,
): string {
  const hash = createHash("sha256").update(appKey).digest("hex").slice(0, 16);
  return `kis:ws:${environment}:${hash}`;
}

type ApprovalCacheEntry = {
  key: string;
  /** Local expiry; KIS docs: refresh on auth failure / daily reAuth pattern. */
  expiresAt: number;
};

const APPROVAL_TTL_MS = 20 * 60 * 60 * 1000; // 20h cache (official reAuth ~24h)
const approvalCache = new Map<string, ApprovalCacheEntry>();
const inflight = new Map<string, Promise<string>>();

export type ApprovalFetch = typeof fetch;

export type ApprovalClientOpts = {
  fetchImpl?: ApprovalFetch;
  /** Force refresh even if cached. */
  force?: boolean;
  now?: () => number;
};

export function clearApprovalCacheForTest(): void {
  approvalCache.clear();
  inflight.clear();
}

export function peekApprovalCacheSizeForTest(): number {
  return approvalCache.size;
}

/**
 * Obtain (or reuse) a WebSocket approval_key for the given PAPER/REAL config.
 * Single-flight per credential session key.
 */
export async function getKisWsApprovalKey(
  config: Pick<KisConfig, "environment" | "appKey" | "appSecret" | "host">,
  opts: ApprovalClientOpts = {},
): Promise<string> {
  const sessionKey = kisCredentialSessionKey(config.environment, config.appKey);
  const now = opts.now ?? Date.now;
  if (!opts.force) {
    const cached = approvalCache.get(sessionKey);
    if (cached && cached.expiresAt > now()) return cached.key;
  } else {
    approvalCache.delete(sessionKey);
  }

  const existing = inflight.get(sessionKey);
  if (existing) return existing;

  const promise = (async () => {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const host = config.host || KIS_HOSTS[config.environment];
    const url = `${host}/oauth2/Approval`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/plain",
        charset: "UTF-8",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: config.appKey,
        secretkey: config.appSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`KIS WebSocket approval failed (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { approval_key?: string };
    const key = String(json.approval_key ?? "").trim();
    if (!key) {
      throw new Error("KIS WebSocket approval_key missing in response");
    }
    approvalCache.set(sessionKey, {
      key,
      expiresAt: now() + APPROVAL_TTL_MS,
    });
    return key;
  })();

  inflight.set(sessionKey, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(sessionKey);
  }
}

/** Invalidate cached approval for a credential (auth rejection / expired). */
export function invalidateKisWsApproval(
  environment: KisEnvironment,
  appKey: string,
): void {
  approvalCache.delete(kisCredentialSessionKey(environment, appKey));
}
