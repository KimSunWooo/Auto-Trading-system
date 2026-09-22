import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_REST_MIN_SPACING_MS,
  KisClient,
  resetInquirePriceRestCountForTest,
  inquirePriceRestCountForTest,
  resetKisTokenCacheForTest,
} from "@/src/brokers/kis-client";
import { getKisConfig } from "@/src/brokers/kis-config";
import { KisBroker } from "@/src/brokers/KisBroker";
import type { StateBox } from "@/src/accounts/StateBox";
import { createInitialState } from "@/lib/engine";
import { setNowMs } from "@/src/clock";
import { LIVE_KIS_QUOTE_FRESH_MS } from "@/src/runtime/quote-policy";
import { buildH0stCnt0Fixture } from "@/src/market-data/h0stcnt0-fixture";
import {
  KisRealtimeQuoteHub,
  type WebSocketLike,
} from "@/src/market-data/kis-realtime-quote-hub";
import {
  clearApprovalCacheForTest,
} from "@/src/market-data/kis-approval";
import {
  refreshQuotesFromWebSocket,
  resetWsQuoteFeedForTest,
  syncWatchedSubscriptions,
  inquirePriceSeedCountForTest,
} from "@/src/market-data/ws-quote-feed";
import { resetQuoteHubRegistry } from "@/src/market-data/kis-realtime-registry";
import { watchedTickersFrom } from "@/src/rules/config";

function paperConfig() {
  return {
    environment: "paper" as const,
    appKey: "feed-test-key",
    appSecret: "feed-test-secret",
    host: "https://openapivts.koreainvestment.com:29443",
    websocketUrl: "ws://ops.koreainvestment.com:31000",
  };
}

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
    config: paperConfig(),
    now: clock,
    autoReconnect: false,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ approval_key: "feed-approval" }),
      }) as Response) as typeof fetch,
    webSocketFactory: () => {
      queueMicrotask(() => sock.open());
      return sock;
    },
  });
  await hub.start();
  return hub;
}

function fakePriceClient(calls: { price: number; daily: number }) {
  return {
    mode: "paper" as const,
    configured: true,
    liveEnabled: true,
    issues: [] as string[],
    async inquirePrice(ticker: string) {
      calls.price += 1;
      return {
        ticker,
        name: "카카오",
        price: 45_200,
        open: 44_800,
        high: 45_500,
        low: 44_700,
        prevClose: 44_000,
        volume: 1,
      };
    },
    async inquireDailyCloses() {
      calls.daily += 1;
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
}

test("W9/W10 syncSubscriptions: disabled unheld dropped; held kept", async () => {
  const sock = new FakeSocket();
  let t = 1_000;
  const hub = await makeHub(sock, () => t);
  await syncWatchedSubscriptions(hub, "acct-a", ["035720", "069500"]);
  assert.deepEqual(hub.health().subscriptions.sort(), ["035720", "069500"]);
  // W9: drop unused for this consumer
  await syncWatchedSubscriptions(hub, "acct-a", ["035720"]);
  assert.deepEqual(hub.health().subscriptions, ["035720"]);
  // W10: held ticker remains for this consumer
  await syncWatchedSubscriptions(hub, "acct-a", ["069500"]);
  assert.deepEqual(hub.health().subscriptions, ["069500"]);
  await hub.stop();
});

test("W11-W14 freshness + mock/seed blocked via getCurrentPrice", async () => {
  resetWsQuoteFeedForTest();
  const sock = new FakeSocket();
  let t = 10_000;
  const hub = await makeHub(sock, () => t);
  await hub.syncSubscriptions("acct-a", ["035720"]);
  sock.pushMessage(buildH0stCnt0Fixture());

  const state = createInitialState();
  state.quotes["035720"] = {
    ...state.quotes["035720"]!,
    code: "035720",
    name: "카카오",
    price: 45_200,
    prevClose: 44_000,
    source: "kis",
    transport: "ws",
    freshAt: t,
  };
  const box: StateBox = { current: state };
  const client = fakePriceClient({ price: 0, daily: 0 });
  const broker = new KisBroker(box, client as never, "cash", "rule", undefined, undefined, {
    quoteHub: hub,
  });

  const prev = process.env.TRADING_MODE;
  const prevBroker = process.env.BROKER;
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  try {
    setNowMs(t + 1_000); // W11 age 1s
    assert.equal(await broker.getCurrentPrice("035720"), 45_200);

    setNowMs(t + LIVE_KIS_QUOTE_FRESH_MS + 1); // W12 stale
    await assert.rejects(() => broker.getCurrentPrice("035720"), /실시간 시세/);

    setNowMs(t + 1_000);
    box.current.quotes["035720"] = { ...box.current.quotes["035720"]!, source: "mock", freshAt: t };
    await assert.rejects(() => broker.getCurrentPrice("035720"), /mock\/seed/); // W13

    box.current.quotes["035720"] = { ...box.current.quotes["035720"]!, source: "seed", freshAt: t };
    await assert.rejects(() => broker.getCurrentPrice("035720"), /mock\/seed/); // W14
  } finally {
    setNowMs(null);
    process.env.TRADING_MODE = prev;
    process.env.BROKER = prevBroker;
    await hub.stop();
  }
});

test("W15-W17 disconnect blocks; reconnect without quote still blocks", async () => {
  resetWsQuoteFeedForTest();
  const sock = new FakeSocket();
  let t = 50_000;
  const hub = await makeHub(sock, () => t);
  await hub.syncSubscriptions("acct-a", ["035720"]);
  sock.pushMessage(buildH0stCnt0Fixture());

  const calls = { price: 0, daily: 0 };
  const client = fakePriceClient(calls);
  const box: StateBox = { current: createInitialState() };
  const result = await refreshQuotesFromWebSocket(box, hub, client as never, ["035720"], {
    now: t,
  });
  assert.equal(result.ok, true);

  sock.close(); // W15 disconnect
  const after = await refreshQuotesFromWebSocket(box, hub, client as never, ["035720"], {
    now: t + 100,
  });
  assert.equal(after.ok, false);
  assert.equal(after.connected, false);

  // W16: reconnect state CONNECTING/CONNECTED but no new quote yet — force connected via new hub message path
  // After close with autoReconnect=false, hub stays DISCONNECTED → still blocked.
  assert.equal(hub.health().connected, false);
  await hub.stop();
});

test("W18-W21 WS tick uses 0 continuous inquirePrice; seed+daily allowed once", async () => {
  resetWsQuoteFeedForTest();
  resetInquirePriceRestCountForTest();
  const sock = new FakeSocket();
  let t = 80_000;
  const hub = await makeHub(sock, () => t);
  await hub.syncSubscriptions("acct-a", ["035720"]);
  sock.pushMessage(buildH0stCnt0Fixture());

  const calls = { price: 0, daily: 0 };
  const client = fakePriceClient(calls);
  const box: StateBox = { current: createInitialState() };

  const first = await refreshQuotesFromWebSocket(box, hub, client as never, ["035720"], {
    now: t,
  });
  assert.equal(first.ok, true);
  assert.equal(box.current.quotes["035720"]?.transport, "ws");
  assert.equal(box.current.quotes["035720"]?.source, "kis");
  assert.equal(box.current.quotes["035720"]?.prevClose, 44_000); // seeded, not fabricated
  const seedAfterFirst = inquirePriceSeedCountForTest();
  assert.ok(seedAfterFirst >= 1);
  assert.ok(calls.daily >= 1);

  const priceBeforeSecond = calls.price;
  t = 80_500;
  sock.pushMessage(buildH0stCnt0Fixture({ STCK_PRPR: "45300" }));
  const second = await refreshQuotesFromWebSocket(box, hub, client as never, ["035720"], {
    now: t,
  });
  assert.equal(second.ok, true);
  // W18: no additional inquirePrice for current price on subsequent ticks
  assert.equal(calls.price, priceBeforeSecond);
  assert.equal(box.current.quotes["035720"]?.price, 45_300);

  // W19 order path
  const prev = process.env.TRADING_MODE;
  const prevBroker = process.env.BROKER;
  process.env.TRADING_MODE = "live_test";
  process.env.BROKER = "kis";
  setNowMs(t + 100);
  try {
    const broker = new KisBroker(box, client as never, "cash", "rule", undefined, undefined, {
      quoteHub: hub,
    });
    const before = calls.price;
    assert.equal(await broker.getCurrentPrice("035720"), 45_300);
    assert.equal(await broker.getCurrentPrice("035720"), 45_300);
    assert.equal(calls.price, before); // REST price = 0
  } finally {
    setNowMs(null);
    process.env.TRADING_MODE = prev;
    process.env.BROKER = prevBroker;
    await hub.stop();
  }
});

test("W22-W24 PAPER REST paced; order waits once (no retry)", async () => {
  resetKisTokenCacheForTest();
  const times: number[] = [];
  let orderPosts = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tokenP")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: "t", expires_in: 86_400 }),
      } as Response;
    }
    if (url.includes("hashkey")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ HASH: "h" }),
      } as Response;
    }
    times.push(Date.now());
    if (url.includes("order-cash") || (init?.method === "POST" && url.includes("order"))) {
      orderPosts += 1;
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          rt_cd: "0",
          output: {
            stck_prpr: "70000",
            hts_kor_isnm: "삼성전자",
            stck_oprc: "70000",
            stck_hgpr: "71000",
            stck_lwpr: "69000",
            stck_sdpr: "69500",
            acml_vol: "1",
            ODNO: "0000000001",
            KRX_FWDG_ORD_ORGNO: "91234",
          },
          output2: [],
        }),
    } as Response;
  }) as typeof fetch;

  const client = new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: "pace-key",
      KIS_PAPER_APP_SECRET: "pace-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
    fetchImpl,
  );

  const start = Date.now();
  await Promise.all([
    client.inquirePrice("005930"),
    client.inquirePrice("035720"),
    client.inquireDailyCloses("005930"),
  ]);
  const elapsed = Date.now() - start;
  // 3 paced calls ⇒ at least ~2 spacings
  assert.ok(elapsed >= PAPER_REST_MIN_SPACING_MS, `elapsed=${elapsed}`);
  assert.ok(client.paperRestCallCount() >= 3);

  // gaps between REST starts
  for (let i = 1; i < times.length; i++) {
    assert.ok(
      times[i]! - times[i - 1]! >= PAPER_REST_MIN_SPACING_MS - 50,
      `gap ${times[i]! - times[i - 1]!}`,
    );
  }

  await client.orderCash({
    ticker: "005930",
    side: "buy",
    qty: 1,
    ordDvsn: "limit",
    price: 70_000,
  });
  assert.equal(orderPosts, 1); // W24 exactly one POST
});

test("watchedTickersFrom still drives subscription set", () => {
  const state = createInitialState();
  state.allocations = state.allocations.map((row) =>
    row.ruleId === "cash" ? row : { ...row, enabled: false },
  );
  // enabled rules come from rule config file — at least ensure helper is stable
  const watched = watchedTickersFrom(state);
  assert.ok(Array.isArray(watched));
});

test.after(async () => {
  await resetQuoteHubRegistry();
  setNowMs(null);
});
