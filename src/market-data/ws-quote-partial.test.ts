/**
 * One lagging watchlist ticker must not fail the whole WS refresh.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "@/lib/engine";
import type { StateBox } from "@/src/accounts/StateBox";
import { setNowMs } from "@/src/clock";
import { buildH0stCnt0Fixture } from "@/src/market-data/h0stcnt0-fixture";
import {
  KisRealtimeQuoteHub,
  type WebSocketLike,
} from "@/src/market-data/kis-realtime-quote-hub";
import { clearApprovalCacheForTest } from "@/src/market-data/kis-approval";
import {
  refreshQuotesFromWebSocket,
  resetWsQuoteFeedForTest,
} from "@/src/market-data/ws-quote-feed";
import { quoteHealthy } from "@/src/runtime/controlled-run";
import { LIVE_KIS_QUOTE_FRESH_MS } from "@/src/runtime/quote-policy";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((fn) => fn !== listener),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  pong(): void {}

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emit(type: string, ev: { data?: unknown }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  pushMessage(raw: string): void {
    this.emit("message", { data: raw });
  }
}

async function makeHub(sock: FakeSocket, clock: () => number) {
  clearApprovalCacheForTest();
  const hub = new KisRealtimeQuoteHub({
    config: {
      environment: "paper",
      appKey: "partial-test-key",
      appSecret: "partial-test-secret",
      host: "https://openapivts.koreainvestment.com:29443",
      websocketUrl: "ws://ops.koreainvestment.com:31000",
    },
    now: clock,
    autoReconnect: false,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ approval_key: "partial-approval" }),
      }) as Response) as typeof fetch,
    webSocketFactory: () => {
      queueMicrotask(() => sock.open());
      return sock;
    },
  });
  await hub.start();
  return hub;
}

test("partial watchlist: connected hub ok even when one ticker missing", async () => {
  resetWsQuoteFeedForTest();
  const sock = new FakeSocket();
  const t = 120_000;
  const hub = await makeHub(sock, () => t);
  await hub.syncSubscriptions("acct-partial", ["035720", "005930"]);
  sock.pushMessage(buildH0stCnt0Fixture({ MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45200" }));

  const client = {
    mode: "paper" as const,
    configured: true,
    liveEnabled: true,
    issues: [] as string[],
    async inquirePrice() {
      return null;
    },
    async inquireDailyCloses() {
      return [40_000, 41_000, 42_000, 43_000, 44_000];
    },
    async inquireDailyCcld() {
      return [];
    },
    async inquireOpenOrders() {
      return [];
    },
    async inquireBalance() {
      return { cash: 0, d2Cash: 0, holdings: [] };
    },
    async orderCash() {
      return { orderNo: "1", krxOrgNo: "1" };
    },
    async cancelOrder() {},
  };

  const box: StateBox = { current: createInitialState() };
  const result = await refreshQuotesFromWebSocket(
    box,
    hub,
    client as never,
    ["035720", "005930"],
    { now: t },
  );
  assert.equal(result.connected, true);
  assert.equal(result.ok, true, "hub connected → global ok despite missing sibling");
  assert.ok(result.missing.includes("005930") || result.projected < 2);
  assert.equal(box.current.quotes["035720"]?.source, "kis");

  setNowMs(t + 500);
  try {
    assert.equal(quoteHealthy(box.current, "035720"), true);
    assert.equal(quoteHealthy(box.current, "005930"), false);
  } finally {
    setNowMs(null);
    await hub.stop();
  }
});

test("stale sibling does not mark target quote unhealthy", () => {
  const now = Date.now();
  setNowMs(now);
  try {
    const state = createInitialState();
    state.quotes = {
      "035720": {
        code: "035720",
        name: "카카오",
        market: "KOSPI",
        price: 45_200,
        prevClose: 44_000,
        open: 45_000,
        high: 45_500,
        low: 44_800,
        volume: 1,
        bid: 45_100,
        ask: 45_300,
        history: [],
        source: "kis",
        transport: "ws",
        freshAt: now,
      },
      "005930": {
        code: "005930",
        name: "삼성전자",
        market: "KOSPI",
        price: 70_000,
        prevClose: 69_000,
        open: 70_000,
        high: 70_000,
        low: 70_000,
        volume: 1,
        bid: 69_900,
        ask: 70_100,
        history: [],
        source: "kis",
        transport: "ws",
        freshAt: now - LIVE_KIS_QUOTE_FRESH_MS - 5_000,
      },
    };
    assert.equal(quoteHealthy(state, "035720"), true);
    assert.equal(quoteHealthy(state, "005930"), false);
  } finally {
    setNowMs(null);
  }
});
