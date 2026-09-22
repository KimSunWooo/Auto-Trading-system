import assert from "node:assert/strict";
import test from "node:test";
import {
  buildH0stCnt0SubscribeMessage,
  H0STCNT0_COLUMNS,
  parseH0stCnt0Realtime,
  parseKisWsSystemMessage,
} from "@/src/market-data/h0stcnt0";
import { buildH0stCnt0Fixture } from "@/src/market-data/h0stcnt0-fixture";
import {
  clearApprovalCacheForTest,
  getKisWsApprovalKey,
  kisCredentialSessionKey,
  peekApprovalCacheSizeForTest,
} from "@/src/market-data/kis-approval";
import {
  KisRealtimeQuoteHub,
  SubscriptionCapacityError,
  type WebSocketLike,
} from "@/src/market-data/kis-realtime-quote-hub";
import {
  acquireQuoteHub,
  quoteHubRefCount,
  quoteHubRegistrySize,
  releaseQuoteHub,
  resetQuoteHubRegistry,
} from "@/src/market-data/kis-realtime-registry";

function paperConfig(appKey = "paper-app-key-aaa") {
  return {
    environment: "paper" as const,
    appKey,
    appSecret: "paper-secret",
    host: "https://openapivts.koreainvestment.com:29443",
    websocketUrl: "ws://ops.koreainvestment.com:31000",
  };
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  pongs: string[] = [];
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

  pong(data?: string): void {
    this.pongs.push(data ?? "");
  }

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

test("W1-W5 H0STCNT0 parser maps official columns", () => {
  const raw = buildH0stCnt0Fixture({
    MKSC_SHRN_ISCD: "035720",
    STCK_PRPR: "45200",
    STCK_OPRC: "44800",
    STCK_HGPR: "45500",
    STCK_LWPR: "44700",
    ASKP1: "45250",
    BIDP1: "45150",
    CNTG_VOL: "12",
    ACML_VOL: "999888",
  });
  const parsed = parseH0stCnt0Realtime(raw);
  assert.ok(parsed);
  assert.equal(parsed!.ticker, "035720"); // W1
  assert.equal(parsed!.price, 45_200); // W2
  assert.equal(parsed!.open, 44_800); // W3
  assert.equal(parsed!.high, 45_500);
  assert.equal(parsed!.low, 44_700);
  assert.equal(parsed!.ask, 45_250); // W4
  assert.equal(parsed!.bid, 45_150);
  assert.equal(parsed!.tradeVolume, 12); // W5
  assert.equal(parsed!.volume, 999_888);
  assert.equal(H0STCNT0_COLUMNS[0], "MKSC_SHRN_ISCD");
  assert.equal(H0STCNT0_COLUMNS[2], "STCK_PRPR");
  assert.equal(H0STCNT0_COLUMNS[10], "ASKP1");
  assert.equal(H0STCNT0_COLUMNS[11], "BIDP1");
});

test("W6 receivedAt is assigned locally by hub, not from STCK_CNTG_HOUR", async () => {
  clearApprovalCacheForTest();
  await resetQuoteHubRegistry();
  let clock = 1_700_000_000_000;
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
    now: () => clock,
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
  });
  await hub.start();
  clock = 1_700_000_000_500;
  sock.pushMessage(buildH0stCnt0Fixture({ STCK_CNTG_HOUR: "090000" }));
  const snap = hub.get("035720");
  assert.ok(snap);
  assert.equal(snap!.receivedAt, 1_700_000_000_500);
  assert.equal(snap!.tradeTime, "090000");
  assert.equal(snap!.transport, "ws");
  assert.equal(snap!.source, "kis");
  await hub.stop();
});

test("subscribe message uses official header/body shape", () => {
  const msg = JSON.parse(
    buildH0stCnt0SubscribeMessage({
      approvalKey: "ak",
      ticker: "035720",
      trType: "1",
    }),
  );
  assert.equal(msg.header.tr_type, "1");
  assert.equal(msg.header.custtype, "P");
  assert.equal(msg.body.input.tr_id, "H0STCNT0");
  assert.equal(msg.body.input.tr_key, "035720");
});

test("W26 PINGPONG receives official pong reply", async () => {
  clearApprovalCacheForTest();
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
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
  });
  await hub.start();
  const ping = JSON.stringify({ header: { tr_id: "PINGPONG" }, body: {} });
  sock.pushMessage(ping);
  assert.equal(sock.pongs.length, 1);
  assert.equal(sock.pongs[0], ping);
  assert.equal(hub.health().connected, true);
  await hub.stop();
});

test("system JSON subscribe success vs failure", () => {
  const ok = parseKisWsSystemMessage(
    JSON.stringify({
      header: { tr_id: "H0STCNT0", tr_key: "035720" },
      body: { rt_cd: "0", msg1: "SUBSCRIBE SUCCESS" },
    }),
  );
  assert.ok(ok);
  assert.equal(ok!.isOk, true);
  assert.equal(ok!.isPingPong, false);

  const bad = parseKisWsSystemMessage(
    JSON.stringify({
      header: { tr_id: "H0STCNT0", tr_key: "035720" },
      body: { rt_cd: "1", msg1: "SUBSCRIBE ERROR" },
    }),
  );
  assert.ok(bad);
  assert.equal(bad!.isOk, false);
});

test("approval key is cached and single-flight (no secret in session key)", async () => {
  clearApprovalCacheForTest();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ approval_key: "cached-key" }),
    } as Response;
  }) as typeof fetch;
  const cfg = paperConfig("same-key");
  const session = kisCredentialSessionKey("paper", "same-key");
  assert.ok(!session.includes("same-key"));
  assert.ok(session.startsWith("kis:ws:paper:"));

  const [a, b] = await Promise.all([
    getKisWsApprovalKey(cfg, { fetchImpl }),
    getKisWsApprovalKey(cfg, { fetchImpl }),
  ]);
  assert.equal(a, "cached-key");
  assert.equal(b, "cached-key");
  assert.equal(calls, 1);
  assert.equal(peekApprovalCacheSizeForTest(), 1);
  await getKisWsApprovalKey(cfg, { fetchImpl });
  assert.equal(calls, 1);
});

test("W7 subscribe once; W8 duplicate subscribe does not resend", async () => {
  clearApprovalCacheForTest();
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
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
  });
  await hub.start();
  const before = sock.sent.length;
  await hub.subscribe("035720");
  assert.equal(sock.sent.length, before + 1);
  await hub.subscribe("035720"); // W8 same tick again
  assert.equal(sock.sent.length, before + 1);
  await hub.stop();
});

test("subscription capacity throws explicit error (no silent drop)", async () => {
  clearApprovalCacheForTest();
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
    autoReconnect: false,
    subscriptionLimit: 2,
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
  });
  await hub.start();
  await hub.subscribe("035720");
  await hub.subscribe("005930");
  await assert.rejects(() => hub.subscribe("069500"), (err: unknown) => {
    assert.ok(err instanceof SubscriptionCapacityError);
    return true;
  });
  await hub.stop();
});

test("W29 same AppKey shares one hub; different AppKey is separate", async () => {
  clearApprovalCacheForTest();
  await resetQuoteHubRegistry();
  const socks: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    socks.push(s);
    queueMicrotask(() => s.open());
    return s;
  };
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ approval_key: "test-approval" }),
    }) as Response) as typeof fetch;

  const a = acquireQuoteHub({
    config: paperConfig("shared-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  });
  const b = acquireQuoteHub({
    config: paperConfig("shared-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  });
  assert.equal(a.sessionKey, b.sessionKey);
  assert.equal(quoteHubRegistrySize(), 1);
  assert.equal(quoteHubRefCount(a.sessionKey), 2);

  const c = acquireQuoteHub({
    config: paperConfig("other-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  });
  assert.notEqual(c.sessionKey, a.sessionKey);
  assert.equal(quoteHubRegistrySize(), 2);

  await releaseQuoteHub(a);
  assert.equal(quoteHubRegistrySize(), 2);
  await releaseQuoteHub(b);
  assert.equal(quoteHubRegistrySize(), 1);
  await releaseQuoteHub(c);
  assert.equal(quoteHubRegistrySize(), 0);
});

test("REAL WebSocket acquire is rejected", () => {
  assert.throws(
    () =>
      acquireQuoteHub({
        config: {
          environment: "real",
          appKey: "x",
          appSecret: "y",
          host: "https://openapi.koreainvestment.com:9443",
          websocketUrl: "ws://ops.koreainvestment.com:21000",
        },
      }),
    /REAL WebSocket is locked/,
  );
});
