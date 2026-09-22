/**
 * KIS PAPER WebSocket H0STCNT0 read-only soak harness.
 * Never mutates autoTrading / controlledRun / rules / orders.
 * Never calls order APIs or inquirePrice.
 */
import { createHash } from "node:crypto";
import { KIS_WS } from "@/src/brokers/kis-config";
import {
  KisClient,
  inquirePriceRestCountForTest,
} from "@/src/brokers/kis-client";
import { getMarketClock } from "@/lib/market-hours";
import { H0STCNT0_TR_ID, KIS_PAPER_WS_PATH } from "@/src/market-data/h0stcnt0";
import type { RealtimeQuoteHub, RealtimeQuoteSnapshot } from "@/src/market-data/kis-realtime-quote-hub";
import {
  acquireQuoteHub,
  dropQuoteHubRef,
} from "@/src/market-data/kis-realtime-registry";
import { LIVE_KIS_QUOTE_FRESH_MS } from "@/src/runtime/quote-policy";
import {
  clearConsumerWatchedSubscriptions,
  syncWatchedSubscriptions,
} from "@/src/market-data/ws-quote-feed";

export { quoteHubRefCount } from "@/src/market-data/kis-realtime-registry";

export const WS_READONLY_SOAK_CONSUMER_ID = "ws-readonly-soak";
export const DEFAULT_WS_SOAK_TICKER = "035720";
export const DEFAULT_WS_SOAK_SECONDS = 300;
export const DEFAULT_FIRST_QUOTE_TIMEOUT_MS = 60_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
export const DEFAULT_SUMMARY_INTERVAL_MS = 8_000;

export type PassFail = "PASS" | "FAIL";

export type PaperWsSoakEnv = Record<string, string | undefined>;

export type PaperWsSoakDeps = {
  /** Injected hub (tests). When omitted, acquires via PAPER KisClient.wsConfig(). */
  hub?: RealtimeQuoteHub;
  /** When true, do not drop registry ref on shutdown (hub was injected / shared). */
  skipRegistryRelease?: boolean;
  acquireHub?: () => RealtimeQuoteHub;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Optional KisClient for live runs — never used for orders/inquirePrice. */
  client?: KisClient;
  /** Capture inquirePrice baseline for report. */
  inquirePriceBaseline?: number;
};

export type PaperWsSoakOpts = PaperWsSoakDeps & {
  ticker?: string;
  durationMs?: number;
  firstQuoteTimeoutMs?: number;
  healthIntervalMs?: number;
  summaryIntervalMs?: number;
  env?: PaperWsSoakEnv;
  freshMs?: number;
};

export type PaperWsSoakReport = {
  environment: "PAPER";
  ticker: string;
  endpoint: string;
  trId: typeof H0STCNT0_TR_ID;
  sessionKeyFingerprint: string;
  durationMs: number;
  connected: boolean;
  firstQuoteReceived: boolean;
  quotesReceived: number;
  lastPrice: number | null;
  lastQuoteAgeMs: number | null;
  lastFreshness: "fresh" | "stale" | "none";
  reconnectCount: number;
  parseErrors: number;
  subscribeErrors: number;
  messagesReceived: number;
  staleQuoteCount: number;
  restInquirePricePolling: number;
  domesticOrders: number;
  overseasOrders: number;
  autoTradingMutations: number;
  orderCapability: "DISABLED";
  autoTradingMutation: "NONE";
  real: "LOCKED";
  failReason?: string;
  marketOpenHint?: string;
  final: {
    actualKisPaperConnection: PassFail;
    h0stcnt0LiveData: PassFail;
    freshQuoteStream: PassFail;
    readOnlySoak: PassFail;
    readyForPaperAutomatedMarketTest: "NO";
  };
};

export class ReadOnlySoakGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReadOnlySoakGuardError";
    this.code = code;
  }
}

/** Absolute order / live ban — PAPER or demo only. */
export function assertReadOnlyPaperEnv(env: PaperWsSoakEnv = process.env): void {
  const kisMode = String(env.KIS_MODE ?? env.KIS_ENV ?? "")
    .trim()
    .toLowerCase();
  if (kisMode !== "paper" && kisMode !== "demo" && kisMode !== "") {
    throw new ReadOnlySoakGuardError(
      "KIS_MODE_NOT_PAPER",
      `Refuse: KIS_MODE must be paper/demo (got ${kisMode || "(empty)"})`,
    );
  }
  if (String(env.ALLOW_LIVE_TRADING ?? "").toLowerCase() === "true") {
    throw new ReadOnlySoakGuardError(
      "ALLOW_LIVE_TRADING",
      "Refuse: ALLOW_LIVE_TRADING must not be true for read-only WS soak",
    );
  }
  if (String(env.TRADING_MODE ?? "").trim().toLowerCase() === "live") {
    throw new ReadOnlySoakGuardError(
      "TRADING_MODE_LIVE",
      "Refuse: TRADING_MODE=live is locked for read-only WS soak",
    );
  }
  if (env.KIS_LIVE_CONFIRM != null && String(env.KIS_LIVE_CONFIRM).length > 0) {
    throw new ReadOnlySoakGuardError(
      "KIS_LIVE_CONFIRM",
      "Refuse: KIS_LIVE_CONFIRM must be absent for read-only WS soak",
    );
  }
}

/** Hash session key for safe display (never print appKey / approval_key). */
export function fingerprintSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

export function paperWsEndpoint(): string {
  return `${KIS_WS.paper}${KIS_PAPER_WS_PATH}`;
}

export function formatStartBanner(opts: {
  ticker: string;
  endpoint: string;
  sessionKeyFingerprint: string;
  durationSec: number;
}): string {
  return [
    "KIS PAPER WebSocket Read-Only Soak",
    "==================================",
    "",
    "Environment:",
    "PAPER",
    "",
    "Ticker:",
    opts.ticker,
    "",
    "Endpoint:",
    opts.endpoint,
    "",
    "TR:",
    H0STCNT0_TR_ID,
    "",
    "SessionKey fingerprint:",
    opts.sessionKeyFingerprint,
    "",
    "Duration (sec):",
    String(opts.durationSec),
    "",
    "AutoTrading Mutation:",
    "NONE",
    "",
    "Order Capability:",
    "DISABLED",
  ].join("\n");
}

export function formatFinalReport(report: PaperWsSoakReport): string {
  const age =
    report.lastQuoteAgeMs == null ? "n/a" : `${report.lastQuoteAgeMs} ms (${report.lastFreshness})`;
  const lines = [
    "KIS PAPER WebSocket Read-Only Soak Report",
    "=========================================",
    "",
    "Duration:",
    `${Math.round(report.durationMs / 1000)} s`,
    "",
    "Connected:",
    report.connected ? "YES" : "NO",
    "",
    "First Quote Received:",
    report.firstQuoteReceived ? "YES" : "NO",
    "",
    "Quotes Received:",
    String(report.quotesReceived),
    "",
    "Last Price:",
    report.lastPrice == null ? "n/a" : String(report.lastPrice),
    "",
    "Last Quote Age:",
    age,
    "",
    "Reconnect Count:",
    String(report.reconnectCount),
    "",
    "Parse Errors:",
    String(report.parseErrors),
    "",
    "Subscribe Errors:",
    String(report.subscribeErrors),
    "",
    "REST inquire-price Polling:",
    String(report.restInquirePricePolling),
    "",
    "Domestic Orders:",
    String(report.domesticOrders),
    "",
    "Overseas Orders:",
    String(report.overseasOrders),
    "",
    "REAL:",
    "LOCKED",
    "",
  ];
  if (report.failReason) {
    lines.push("Fail Reason:", report.failReason, "");
  }
  if (report.marketOpenHint) {
    lines.push("Market Session:", report.marketOpenHint, "");
  }
  lines.push(
    "FINAL",
    "-----",
    "",
    "Actual KIS PAPER Connection:",
    report.final.actualKisPaperConnection,
    "",
    "H0STCNT0 Live Data:",
    report.final.h0stcnt0LiveData,
    "",
    "Fresh Quote Stream:",
    report.final.freshQuoteStream,
    "",
    "Read-Only Soak:",
    report.final.readOnlySoak,
    "",
    "Ready For PAPER Automated Market Test:",
    "NO",
  );
  return lines.join("\n");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshnessOf(ageMs: number | null, freshMs: number): "fresh" | "stale" | "none" {
  if (ageMs == null) return "none";
  return ageMs <= freshMs ? "fresh" : "stale";
}

function formatQuoteLine(snap: RealtimeQuoteSnapshot, now: number, freshMs: number): string {
  const ageMs = now - snap.receivedAt;
  const fresh = freshnessOf(ageMs, freshMs);
  return [
    `quote ticker=${snap.ticker}`,
    `price=${snap.price}`,
    `bid=${snap.bid}`,
    `ask=${snap.ask}`,
    `open=${snap.open}`,
    `high=${snap.high}`,
    `low=${snap.low}`,
    `volume=${snap.volume}`,
    `tradeVolume=${snap.tradeVolume ?? "n/a"}`,
    `businessDate=${snap.businessDate ?? "n/a"}`,
    `tradeTime=${snap.tradeTime ?? "n/a"}`,
    `receivedAt=${snap.receivedAt}`,
    `ageMs=${ageMs}`,
    `freshness=${fresh}`,
  ].join(" ");
}

function formatHealthLine(hub: RealtimeQuoteHub): string {
  const h = hub.health();
  return [
    `health connected=${h.connected}`,
    `state=${h.state}`,
    `lastMessageAt=${h.lastMessageAt ?? "n/a"}`,
    `lastQuoteAt=${h.lastQuoteAt ?? "n/a"}`,
    `reconnectCount=${h.reconnectCount}`,
    `messagesReceived=${h.messagesReceived}`,
    `parseErrors=${h.parseErrors}`,
    `staleQuoteCount=${h.staleQuoteCount}`,
    `subscribeErrors=${h.subscribeErrors}`,
    `subscriptions=[${h.subscriptions.join(",")}]`,
  ].join(" ");
}

function marketSessionHint(nowMs: number): string {
  const clock = getMarketClock(new Date(nowMs));
  if (clock.open) return `OPEN (${clock.sessionLabel})`;
  return `CLOSED / non-regular (${clock.sessionLabel}) — WS_CONNECTED_BUT_NO_QUOTE may be expected off-hours`;
}

/**
 * Run read-only H0STCNT0 observation. Does not mutate trading state or place orders.
 */
export async function runPaperWsReadOnlySoak(opts: PaperWsSoakOpts = {}): Promise<PaperWsSoakReport> {
  const env = opts.env ?? process.env;
  assertReadOnlyPaperEnv(env);

  const ticker = String(opts.ticker ?? env.WS_SOAK_TICKER ?? DEFAULT_WS_SOAK_TICKER).trim() || DEFAULT_WS_SOAK_TICKER;
  const durationMs =
    opts.durationMs ??
    Math.max(1_000, Number(env.WS_SOAK_SECONDS ?? DEFAULT_WS_SOAK_SECONDS) * 1000 || DEFAULT_WS_SOAK_SECONDS * 1000);
  const firstQuoteTimeoutMs =
    opts.firstQuoteTimeoutMs ??
    Math.max(1_000, Number(env.WS_SOAK_FIRST_QUOTE_MS ?? DEFAULT_FIRST_QUOTE_TIMEOUT_MS) || DEFAULT_FIRST_QUOTE_TIMEOUT_MS);
  const healthIntervalMs = opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const summaryIntervalMs = opts.summaryIntervalMs ?? DEFAULT_SUMMARY_INTERVAL_MS;
  const freshMs = opts.freshMs ?? LIVE_KIS_QUOTE_FRESH_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((line: string) => console.log(line));

  const inquireBaseline = opts.inquirePriceBaseline ?? inquirePriceRestCountForTest();

  let hub: RealtimeQuoteHub;
  let ownsRegistryRef = false;
  if (opts.hub) {
    hub = opts.hub;
    ownsRegistryRef = !opts.skipRegistryRelease;
  } else if (opts.acquireHub) {
    hub = opts.acquireHub();
    ownsRegistryRef = !opts.skipRegistryRelease;
  } else {
    const client = opts.client ?? KisClient.fromEnv(env);
    if (!client.configured || client.mode !== "paper") {
      throw new ReadOnlySoakGuardError(
        "KIS_CLIENT_NOT_PAPER",
        "Refuse: KisClient must be configured PAPER for read-only WS soak",
      );
    }
    hub = acquireQuoteHub({ config: client.wsConfig() });
    ownsRegistryRef = true;
  }

  const endpoint = paperWsEndpoint();
  const sessionFp = fingerprintSessionKey(hub.sessionKey);
  const startedAt = now();
  let quotesReceived = 0;
  let firstQuoteReceived = 0;
  let lastSnap: RealtimeQuoteSnapshot | null = null;
  let sawConnected = false;
  let sawFresh = false;
  let failReason: string | undefined;
  let shutDown = false;

  log(
    formatStartBanner({
      ticker,
      endpoint,
      sessionKeyFingerprint: sessionFp,
      durationSec: Math.round(durationMs / 1000),
    }),
  );

  const cleanup = async () => {
    if (shutDown) return;
    shutDown = true;
    try {
      await clearConsumerWatchedSubscriptions(hub, WS_READONLY_SOAK_CONSUMER_ID);
    } catch {
      /* ignore */
    }
    if (ownsRegistryRef) {
      await dropQuoteHubRef(hub);
    }
  };

  const onAbort = () => {
    /* loop observes signal.aborted; cleanup runs once in finally */
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await syncWatchedSubscriptions(hub, WS_READONLY_SOAK_CONSUMER_ID, [ticker]);
    const health0 = hub.health();
    if (health0.connected || health0.state === "CONNECTING" || health0.state === "RECONNECTING") {
      sawConnected = health0.connected || sawConnected;
    }

    let lastHealthAt = startedAt;
    let lastSummaryAt = startedAt;
    let lastLoggedQuoteAt = 0;

    while (true) {
      if (opts.signal?.aborted) {
        failReason = failReason ?? "ABORTED";
        break;
      }
      const t = now();
      const elapsed = t - startedAt;
      if (elapsed >= durationMs) break;

      const health = hub.health();
      if (health.connected) sawConnected = true;

      const snap = hub.get(ticker);
      if (snap && snap.price > 0) {
        const isNew = !lastSnap || snap.receivedAt !== lastSnap.receivedAt;
        if (isNew) {
          quotesReceived += 1;
          lastSnap = snap;
          if (!firstQuoteReceived) {
            firstQuoteReceived = snap.receivedAt;
            log(`first ${formatQuoteLine(snap, t, freshMs)}`);
            lastLoggedQuoteAt = t;
          }
        }
        const age = t - snap.receivedAt;
        if (age <= freshMs) sawFresh = true;
      }

      if (!firstQuoteReceived && elapsed >= firstQuoteTimeoutMs) {
        failReason = "WS_CONNECTED_BUT_NO_QUOTE";
        log(`FAIL ${failReason} after ${Math.round(elapsed / 1000)}s (connected=${sawConnected})`);
        log(`Market session: ${marketSessionHint(t)}`);
        break;
      }

      if (t - lastHealthAt >= healthIntervalMs) {
        log(formatHealthLine(hub));
        lastHealthAt = t;
      }

      if (
        firstQuoteReceived &&
        lastSnap &&
        t - lastSummaryAt >= summaryIntervalMs &&
        t - lastLoggedQuoteAt >= summaryIntervalMs
      ) {
        log(`summary ${formatQuoteLine(lastSnap, t, freshMs)} quotesReceived=${quotesReceived}`);
        lastSummaryAt = t;
        lastLoggedQuoteAt = t;
      }

      await sleep(250);
      if (opts.signal?.aborted) {
        failReason = failReason ?? "ABORTED";
        break;
      }
    }
  } catch (err) {
    failReason = err instanceof Error ? err.message : "soak failed";
    log(`ERROR ${failReason}`);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await cleanup();
  }

  const endedAt = now();
  const healthEnd = hub.health();
  const lastAge = lastSnap ? endedAt - lastSnap.receivedAt : null;
  const lastFreshness = freshnessOf(lastAge, freshMs);
  const restInquire = Math.max(0, inquirePriceRestCountForTest() - inquireBaseline);
  const marketOpenHint = marketSessionHint(endedAt);

  if (!failReason && !firstQuoteReceived) {
    failReason = sawConnected ? "WS_CONNECTED_BUT_NO_QUOTE" : "WS_NOT_CONNECTED";
  }

  const readOnlyOk = restInquire === 0;
  const connectionPass: PassFail = sawConnected || healthEnd.connected ? "PASS" : "FAIL";
  const livePass: PassFail = firstQuoteReceived ? "PASS" : "FAIL";
  const freshPass: PassFail = sawFresh ? "PASS" : "FAIL";
  const readOnlyPass: PassFail = readOnlyOk ? "PASS" : "FAIL";

  return {
    environment: "PAPER",
    ticker,
    endpoint,
    trId: H0STCNT0_TR_ID,
    sessionKeyFingerprint: sessionFp,
    durationMs: endedAt - startedAt,
    connected: sawConnected || healthEnd.connected,
    firstQuoteReceived: Boolean(firstQuoteReceived),
    quotesReceived,
    lastPrice: lastSnap?.price ?? null,
    lastQuoteAgeMs: lastAge,
    lastFreshness,
    reconnectCount: healthEnd.reconnectCount,
    parseErrors: healthEnd.parseErrors,
    subscribeErrors: healthEnd.subscribeErrors,
    messagesReceived: healthEnd.messagesReceived,
    staleQuoteCount: healthEnd.staleQuoteCount,
    restInquirePricePolling: restInquire,
    domesticOrders: 0,
    overseasOrders: 0,
    autoTradingMutations: 0,
    orderCapability: "DISABLED",
    autoTradingMutation: "NONE",
    real: "LOCKED",
    failReason,
    marketOpenHint,
    final: {
      actualKisPaperConnection: connectionPass,
      h0stcnt0LiveData: livePass,
      freshQuoteStream: freshPass,
      readOnlySoak: readOnlyPass,
      readyForPaperAutomatedMarketTest: "NO",
    },
  };
}

/** Test helper: expose consumer id constant. */
export function soakConsumerId(): string {
  return WS_READONLY_SOAK_CONSUMER_ID;
}
