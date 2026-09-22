/**
 * Persistent KIS PAPER WebSocket quote hub (H0STCNT0).
 * One connection per AppKey session — no per-tick connect/disconnect.
 * Consumer-scoped subscriptions: same AppKey accounts share a hub without
 * overwriting each other's ticker sets (union ownership).
 * Orders are never placed here.
 */
import type { KisConfig, KisEnvironment } from "@/src/brokers/kis-config";
import { KIS_WS } from "@/src/brokers/kis-config";
import { nowMs } from "@/src/clock";
import {
  buildH0stCnt0SubscribeMessage,
  H0STCNT0_TR_ID,
  KIS_PAPER_WS_PATH,
  KIS_WS_SUBSCRIPTION_LIMIT,
  KIS_WS_TR_TYPE,
  parseH0stCnt0RealtimeBatch,
  parseKisWsSystemMessage,
} from "@/src/market-data/h0stcnt0";
import {
  getKisWsApprovalKey,
  invalidateKisWsApproval,
  kisCredentialSessionKey,
  type ApprovalFetch,
} from "@/src/market-data/kis-approval";
import { createServerWebSocketFactory } from "@/src/market-data/kis-ws-node";

export type RealtimeQuoteSnapshot = {
  ticker: string;
  price: number;
  open: number;
  high: number;
  low: number;
  bid: number;
  ask: number;
  volume: number;
  tradeVolume?: number;
  businessDate?: string;
  tradeTime?: string;
  /** Local receive time — freshness authority. */
  receivedAt: number;
  source: "kis";
  transport: "ws";
};

export type QuoteHubConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "STOPPED";

export type QuoteHubHealth = {
  connected: boolean;
  state: QuoteHubConnectionState;
  lastMessageAt?: number;
  lastQuoteAt?: number;
  lastError?: string;
  reconnectCount: number;
  approvalRefreshCount: number;
  messagesReceived: number;
  parseErrors: number;
  staleQuoteCount: number;
  /** Actual KIS subscription union across all consumers. */
  subscriptions: string[];
  subscribeErrors: number;
  consumers: string[];
};

export interface RealtimeQuoteHub {
  readonly sessionKey: string;
  start(): Promise<void>;
  /**
   * Replace one consumer's desired tickers; hub actual = union of all consumers.
   * consumerId = brokerAccountId (or bootstrap-owner).
   */
  syncSubscriptions(consumerId: string, tickers: Iterable<string>): Promise<void>;
  /** Drop one consumer's set and recompute union (other accounts untouched). */
  clearConsumerSubscriptions(consumerId: string): Promise<void>;
  get(ticker: string): RealtimeQuoteSnapshot | null;
  health(): QuoteHubHealth;
  stop(): Promise<void>;
}

export type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
  removeEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
  /** Optional: Node ws / Python-style pong control frame. */
  pong?(data?: string): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;
const MAX_BACKOFF_MS = 30_000;

export type KisRealtimeQuoteHubOpts = {
  config: Pick<KisConfig, "environment" | "appKey" | "appSecret" | "host" | "websocketUrl">;
  fetchImpl?: ApprovalFetch;
  webSocketFactory?: WebSocketFactory;
  /** Path suffix — official samples use /tryitout. */
  wsPath?: string;
  /** Max subscriptions (default KIS_WS_SUBSCRIPTION_LIMIT). */
  subscriptionLimit?: number;
  /** Inject clock for tests. */
  now?: () => number;
  /** Disable auto-reconnect (tests). */
  autoReconnect?: boolean;
  /** Backoff base ms. */
  backoffBaseMs?: number;
};

export class SubscriptionCapacityError extends Error {
  readonly code = "WS_SUBSCRIPTION_CAPACITY" as const;
  constructor(
    readonly ticker: string,
    readonly limit: number,
  ) {
    super(
      `KIS WebSocket subscription limit (${limit}) exceeded; ${ticker} cannot be subscribed (NO TRADE)`,
    );
    this.name = "SubscriptionCapacityError";
  }
}

export class KisRealtimeQuoteHub implements RealtimeQuoteHub {
  readonly sessionKey: string;
  private readonly config: KisRealtimeQuoteHubOpts["config"];
  private readonly fetchImpl?: ApprovalFetch;
  private readonly wsFactory: WebSocketFactory;
  private readonly wsUrl: string;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly autoReconnect: boolean;
  private readonly backoffBaseMs: number;

  private state: QuoteHubConnectionState = "DISCONNECTED";
  private socket: WebSocketLike | null = null;
  private approvalKey: string | null = null;

  /** consumerId (brokerAccountId) → tickers that consumer needs. */
  private readonly consumerSubscriptions = new Map<string, Set<string>>();
  /** Actual KIS subscription set (= union of consumers). */
  private actual = new Set<string>();
  private readonly confirmed = new Set<string>();
  private readonly quotes = new Map<string, RealtimeQuoteSnapshot>();

  private reconnectCount = 0;
  private approvalRefreshCount = 0;
  private messagesReceived = 0;
  private parseErrors = 0;
  private staleQuoteCount = 0;
  private subscribeErrors = 0;
  private lastMessageAt?: number;
  private lastQuoteAt?: number;
  private lastError?: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopped = false;
  private intentionalClose = false;

  constructor(opts: KisRealtimeQuoteHubOpts) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl;
    this.sessionKey = kisCredentialSessionKey(opts.config.environment, opts.config.appKey);
    const base = opts.config.websocketUrl || KIS_WS[opts.config.environment];
    const path = opts.wsPath ?? KIS_PAPER_WS_PATH;
    this.wsUrl = base.endsWith(path) ? base : `${base.replace(/\/$/, "")}${path}`;
    this.limit = opts.subscriptionLimit ?? KIS_WS_SUBSCRIPTION_LIMIT;
    this.now = opts.now ?? nowMs;
    this.autoReconnect = opts.autoReconnect !== false;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.wsFactory = opts.webSocketFactory ?? createServerWebSocketFactory();
  }

  async start(): Promise<void> {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.state === "CONNECTED" || this.state === "CONNECTING") {
      return this.startPromise ?? Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.connect();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async syncSubscriptions(consumerId: string, tickers: Iterable<string>): Promise<void> {
    const id = normalizeConsumerId(consumerId);
    const nextConsumer = new Set<string>();
    for (const t of tickers) {
      const code = normalizeTicker(t);
      if (code) nextConsumer.add(code);
    }

    const prevUnion = this.unionDesired();
    const provisional = this.computeUnionWith(id, nextConsumer);
    if (provisional.size > this.limit) {
      this.subscribeErrors += 1;
      const overflow = [...provisional].find((t) => !prevUnion.has(t)) ?? [...provisional][this.limit]!;
      throw new SubscriptionCapacityError(overflow, this.limit);
    }

    if (nextConsumer.size === 0) this.consumerSubscriptions.delete(id);
    else this.consumerSubscriptions.set(id, nextConsumer);

    const nextUnion = this.unionDesired();
    await this.applyUnionDiff(prevUnion, nextUnion);

    if (nextUnion.size > 0 && this.state !== "CONNECTED" && this.state !== "CONNECTING") {
      await this.start();
    }
  }

  async clearConsumerSubscriptions(consumerId: string): Promise<void> {
    await this.syncSubscriptions(consumerId, []);
  }

  get(ticker: string): RealtimeQuoteSnapshot | null {
    return this.quotes.get(normalizeTicker(ticker)) ?? null;
  }

  health(): QuoteHubHealth {
    const connected = this.state === "CONNECTED";
    let stale = 0;
    const now = this.now();
    for (const q of this.quotes.values()) {
      if (now - q.receivedAt > 15_000) stale += 1;
    }
    this.staleQuoteCount = stale;
    return {
      connected,
      state: this.state,
      lastMessageAt: this.lastMessageAt,
      lastQuoteAt: this.lastQuoteAt,
      lastError: this.lastError,
      reconnectCount: this.reconnectCount,
      approvalRefreshCount: this.approvalRefreshCount,
      messagesReceived: this.messagesReceived,
      parseErrors: this.parseErrors,
      staleQuoteCount: stale,
      subscriptions: [...this.actual].sort(),
      subscribeErrors: this.subscribeErrors,
      consumers: [...this.consumerSubscriptions.keys()].sort(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.state = "STOPPED";
    const sock = this.socket;
    this.socket = null;
    if (sock && sock.readyState === WS_OPEN) {
      try {
        sock.close(1000, "hub-stop");
      } catch {
        /* ignore */
      }
    }
    this.confirmed.clear();
  }

  /** Test helper: inject a raw WS message. */
  handleRawMessageForTest(raw: string): void {
    this.onMessage(raw);
  }

  /** Test helper: read one consumer's set. */
  consumerTickersForTest(consumerId: string): string[] {
    return [...(this.consumerSubscriptions.get(normalizeConsumerId(consumerId)) ?? [])].sort();
  }

  private unionDesired(): Set<string> {
    const u = new Set<string>();
    for (const set of this.consumerSubscriptions.values()) {
      for (const t of set) u.add(t);
    }
    return u;
  }

  private computeUnionWith(consumerId: string, tickers: Set<string>): Set<string> {
    const u = new Set<string>();
    for (const [id, set] of this.consumerSubscriptions) {
      if (id === consumerId) continue;
      for (const t of set) u.add(t);
    }
    for (const t of tickers) u.add(t);
    return u;
  }

  private async applyUnionDiff(prev: Set<string>, next: Set<string>): Promise<void> {
    for (const code of prev) {
      if (!next.has(code)) {
        this.actual.delete(code);
        this.confirmed.delete(code);
        if (this.state === "CONNECTED" && this.socket && this.approvalKey) {
          await this.sendSub(code, KIS_WS_TR_TYPE.unsubscribe);
        }
      }
    }
    for (const code of next) {
      if (!prev.has(code)) {
        this.actual.add(code);
        if (this.state === "CONNECTED" && this.socket && this.approvalKey) {
          await this.sendSub(code, KIS_WS_TR_TYPE.subscribe);
        }
      }
    }
    this.actual = new Set(next);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.state = this.reconnectCount > 0 ? "RECONNECTING" : "CONNECTING";
    this.intentionalClose = false;
    try {
      const forceApproval = this.lastError?.includes("approval") === true;
      if (forceApproval) {
        invalidateKisWsApproval(this.config.environment as KisEnvironment, this.config.appKey);
      }
      this.approvalKey = await getKisWsApprovalKey(this.config, {
        fetchImpl: this.fetchImpl,
        force: forceApproval,
        now: this.now,
      });
      if (forceApproval || this.approvalRefreshCount === 0) {
        this.approvalRefreshCount += 1;
      }

      const socket = this.wsFactory(this.wsUrl);
      this.socket = socket;

      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("KIS WebSocket connection error"));
        };
        const onCloseEarly = () => {
          cleanup();
          reject(new Error("KIS WebSocket closed before open"));
        };
        const cleanup = () => {
          socket.removeEventListener?.("open", onOpen);
          socket.removeEventListener?.("error", onError);
          socket.removeEventListener?.("close", onCloseEarly);
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onCloseEarly);
        if (socket.readyState === WS_OPEN) {
          cleanup();
          resolve();
        }
      });

      socket.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data ?? "");
        this.onMessage(data);
      });
      socket.addEventListener("close", () => {
        this.onClose();
      });
      socket.addEventListener("error", () => {
        this.lastError = "KIS WebSocket error";
      });

      this.state = "CONNECTED";
      this.lastError = undefined;
      this.confirmed.clear();
      for (const code of this.actual) {
        await this.sendSub(code, KIS_WS_TR_TYPE.subscribe);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : "WebSocket connect failed";
      this.state = "DISCONNECTED";
      this.socket = null;
      this.scheduleReconnect();
      throw err;
    }
  }

  private onMessage(raw: string): void {
    this.messagesReceived += 1;
    this.lastMessageAt = this.now();

    const system = parseKisWsSystemMessage(raw);
    if (system) {
      if (system.isPingPong) {
        this.replyPingPong(raw);
        return;
      }
      if (!system.isOk) {
        this.subscribeErrors += 1;
        this.lastError = system.message ?? "subscribe failed";
        if (/approval|접속키|인증|expired|expire/i.test(system.message ?? "")) {
          invalidateKisWsApproval(this.config.environment as KisEnvironment, this.config.appKey);
          this.approvalKey = null;
        }
        return;
      }
      if (system.trId === H0STCNT0_TR_ID && system.trKey && !system.isUnSub) {
        this.confirmed.add(normalizeTicker(system.trKey));
      }
      return;
    }

    const batch = parseH0stCnt0RealtimeBatch(raw);
    if (batch.rows.length === 0) {
      this.parseErrors += 1;
      return;
    }
    if (batch.malformedRows > 0) {
      this.parseErrors += batch.malformedRows;
    }
    const receivedAt = this.now();
    for (const parsed of batch.rows) {
      const snap: RealtimeQuoteSnapshot = {
        ticker: parsed.ticker,
        price: parsed.price,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        bid: parsed.bid,
        ask: parsed.ask,
        volume: parsed.volume,
        tradeVolume: parsed.tradeVolume,
        businessDate: parsed.businessDate || undefined,
        tradeTime: parsed.tradeTime || undefined,
        receivedAt,
        source: "kis",
        transport: "ws",
      };
      this.quotes.set(parsed.ticker, snap);
      this.lastQuoteAt = receivedAt;
    }
  }

  private replyPingPong(raw: string): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== WS_OPEN) return;
    try {
      // Official Python sample: await ws.pong(raw). Also echo text (common KIS clients).
      if (typeof sock.pong === "function") {
        sock.pong(raw);
      } else {
        sock.send(raw);
      }
    } catch {
      this.lastError = "PINGPONG reply failed";
    }
  }

  private onClose(): void {
    this.socket = null;
    this.confirmed.clear();
    if (this.intentionalClose || this.stopped) {
      this.state = "STOPPED";
      return;
    }
    this.state = "DISCONNECTED";
    this.lastError = this.lastError ?? "WebSocket disconnected";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.stopped) return;
    if (this.reconnectTimer) return;
    const attempt = this.reconnectCount;
    const exp = Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** attempt);
    const jitter = Math.floor(Math.random() * Math.min(250, exp * 0.2));
    const delay = exp + jitter;
    this.reconnectCount += 1;
    this.state = "RECONNECTING";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        /* scheduleReconnect from connect failure */
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async sendSub(ticker: string, trType: "1" | "2"): Promise<void> {
    const sock = this.socket;
    const key = this.approvalKey;
    if (!sock || sock.readyState !== WS_OPEN || !key) return;
    const msg = buildH0stCnt0SubscribeMessage({
      approvalKey: key,
      ticker,
      trType,
    });
    sock.send(msg);
  }
}

function normalizeTicker(ticker: string): string {
  return String(ticker ?? "").trim();
}

function normalizeConsumerId(consumerId: string): string {
  const id = String(consumerId ?? "").trim();
  return id || "__default__";
}
