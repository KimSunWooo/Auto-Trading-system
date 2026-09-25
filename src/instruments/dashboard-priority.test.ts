/**
 * D1–D6 dashboard subscription priority guards (unit, no live orders).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRepresentativeDashboard,
  resetDashboardQuoteCacheForTest,
} from "@/src/instruments/dashboard-quotes";
import {
  dashboardConsumerId,
  executionConsumerId,
  isLowPriorityConsumer,
  previewConsumerId,
  QUOTE_PRIORITY,
} from "@/src/market-data/quote-priority";
import {
  clearApprovalCacheForTest,
} from "@/src/market-data/kis-approval";
import {
  KisRealtimeQuoteHub,
  type WebSocketLike,
} from "@/src/market-data/kis-realtime-quote-hub";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    for (const fn of this.listeners.get("open") ?? []) fn({});
  }
}

test("D2 dashboard consumer id account-scoped + priority order", () => {
  assert.equal(dashboardConsumerId("acct-1"), "dashboard:acct-1");
  assert.equal(previewConsumerId("acct-1"), "preview:acct-1");
  assert.equal(executionConsumerId("acct-1"), "acct-1");
  assert.equal(isLowPriorityConsumer("dashboard:acct-1"), true);
  assert.equal(isLowPriorityConsumer("acct-1"), false);
  assert.ok(QUOTE_PRIORITY.dashboard > QUOTE_PRIORITY.execution);
  assert.ok(QUOTE_PRIORITY.preview > QUOTE_PRIORITY.execution);
});

test("D1/D5/D6 KR cards: KIS local quote live; missing unavailable never fake", () => {
  resetDashboardQuoteCacheForTest();
  const cards = buildRepresentativeDashboard({
    country: "KR",
    localQuotes: {
      "005930": { price: 70000, bid: 69900, ask: 70100, freshAt: Date.now(), source: "kis" },
      "000660": { price: 1, freshAt: Date.now(), source: "seed" },
    },
  });
  assert.ok(cards.length >= 5);
  const samsung = cards.find((c) => c.instrument.symbol === "005930");
  assert.equal(samsung?.source, "ws");
  assert.equal(samsung?.price, 70000);
  assert.equal(samsung?.bid, 69900);
  assert.equal(samsung?.ask, 70100);
  assert.equal(samsung?.blocksTrading, false);
  // seed source must not invent a live dashboard price
  const hynix = cards.find((c) => c.instrument.symbol === "000660");
  assert.equal(hynix?.status, "unavailable");
  assert.equal(hynix?.price, null);
  assert.equal(hynix?.source, "none");
  assert.ok(cards.every((c) => c.blocksTrading === false));
});

test("D3/D4 dashboard cannot evict execution; soft-fail on capacity", async () => {
  clearApprovalCacheForTest();
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: {
      environment: "paper",
      appKey: "dash-key",
      appSecret: "dash-secret",
      host: "https://example",
      websocketUrl: "ws://example",
    },
    autoReconnect: false,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ approval_key: "test-approval" }),
      }) as Response) as typeof fetch,
    webSocketFactory: () => {
      queueMicrotask(() => sock.open());
      return sock;
    },
    subscriptionLimit: 2,
  });
  await hub.start();
  await hub.syncSubscriptions("acct-exec", ["005930", "000660"]);
  await hub.syncSubscriptions("dashboard:acct-exec", ["035720", "035420", "005380"]);
  const health = hub.health();
  assert.ok(health.subscriptions.includes("005930"));
  assert.ok(health.subscriptions.includes("000660"));
  // Dashboard extras must not displace execution tickers.
  assert.equal(health.subscriptions.includes("035720"), false);
  await hub.stop();
});
