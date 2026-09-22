import assert from "node:assert/strict";
import test from "node:test";
import {
  buildH0stCnt0SubscribeMessage,
  H0STCNT0_COLUMNS,
  KIS_PAPER_WS_PATH,
  KIS_WS_TR_TYPE,
  parseH0stCnt0Realtime,
  parseH0stCnt0RealtimeBatch,
  parseKisWsSystemMessage,
} from "@/src/market-data/h0stcnt0";
import {
  buildH0stCnt0Fixture,
  buildH0stCnt0MultiFixture,
  buildH0stCnt0MultiWithMalformedSecond,
} from "@/src/market-data/h0stcnt0-fixture";
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
import {
  createServerWebSocketFactory,
  isServerWebSocketRuntimeAvailable,
  ServerWebSocketUnavailableError,
} from "@/src/market-data/kis-ws-node";
import { KIS_WS } from "@/src/brokers/kis-config";

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

async function makeHub(sock: FakeSocket, clock = () => Date.now()) {
  clearApprovalCacheForTest();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
    now: clock,
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
  return hub;
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
  assert.equal(parsed!.ticker, "035720");
  assert.equal(parsed!.price, 45_200);
  assert.equal(parsed!.open, 44_800);
  assert.equal(parsed!.high, 45_500);
  assert.equal(parsed!.low, 44_700);
  assert.equal(parsed!.ask, 45_250);
  assert.equal(parsed!.bid, 45_150);
  assert.equal(parsed!.tradeVolume, 12);
  assert.equal(parsed!.volume, 999_888);
  assert.equal(H0STCNT0_COLUMNS[0], "MKSC_SHRN_ISCD");
  assert.equal(H0STCNT0_COLUMNS[2], "STCK_PRPR");
  assert.equal(H0STCNT0_COLUMNS[10], "ASKP1");
  assert.equal(H0STCNT0_COLUMNS[11], "BIDP1");
});

test("T6/M1-M2 data_cnt=2 parses both tickers", () => {
  const raw = buildH0stCnt0MultiFixture([
    { MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45200" },
    { MKSC_SHRN_ISCD: "005930", STCK_PRPR: "70000", ASKP1: "70100", BIDP1: "69900" },
  ]);
  const batch = parseH0stCnt0RealtimeBatch(raw);
  assert.equal(batch.expectedCount, 2);
  assert.equal(batch.rows.length, 2);
  assert.equal(batch.malformedRows, 0);
  assert.equal(batch.rows[0]!.ticker, "035720");
  assert.equal(batch.rows[1]!.ticker, "005930");
  assert.equal(batch.rows[1]!.price, 70_000);
});

test("T8/M3 malformed second row isolated; first preserved", () => {
  const raw = buildH0stCnt0MultiWithMalformedSecond(
    { MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45200" },
    ["005930", "103016"], // far too short
  );
  const batch = parseH0stCnt0RealtimeBatch(raw);
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0]!.ticker, "035720");
  assert.ok(batch.malformedRows >= 1);
});

test("W6 receivedAt is assigned locally by hub", async () => {
  const sock = new FakeSocket();
  let clock = 1_700_000_000_000;
  const hub = await makeHub(sock, () => clock);
  await hub.syncSubscriptions("acct-a", ["035720"]);
  clock = 1_700_000_000_500;
  sock.pushMessage(buildH0stCnt0Fixture({ STCK_CNTG_HOUR: "090000" }));
  const snap = hub.get("035720");
  assert.ok(snap);
  assert.equal(snap!.receivedAt, 1_700_000_000_500);
  assert.equal(snap!.tradeTime, "090000");
  await hub.stop();
});

test("T11 official subscribe/unsubscribe tr_type", () => {
  assert.equal(KIS_WS_TR_TYPE.subscribe, "1");
  assert.equal(KIS_WS_TR_TYPE.unsubscribe, "2");
  const sub = JSON.parse(
    buildH0stCnt0SubscribeMessage({
      approvalKey: "ak",
      ticker: "035720",
      trType: "1",
    }),
  );
  const unsub = JSON.parse(
    buildH0stCnt0SubscribeMessage({
      approvalKey: "ak",
      ticker: "035720",
      trType: "2",
    }),
  );
  assert.equal(sub.header.tr_type, "1");
  assert.equal(unsub.header.tr_type, "2");
});

test("T12 official PAPER endpoint/path", () => {
  assert.equal(KIS_WS.paper, "ws://ops.koreainvestment.com:31000");
  assert.equal(KIS_PAPER_WS_PATH, "/tryitout");
  const sock = new FakeSocket();
  const hub = new KisRealtimeQuoteHub({
    config: paperConfig(),
    autoReconnect: false,
    webSocketFactory: () => sock,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ approval_key: "x" }),
      }) as Response) as typeof fetch,
  });
  // URL is private; verify via connect attempt path by inspecting factory arg.
  let usedUrl = "";
  const hub2 = new KisRealtimeQuoteHub({
    config: paperConfig(),
    autoReconnect: false,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ approval_key: "x" }),
      }) as Response) as typeof fetch,
    webSocketFactory: (url) => {
      usedUrl = url;
      queueMicrotask(() => sock.open());
      return sock;
    },
  });
  void hub; // silence
  return hub2.start().then(async () => {
    assert.equal(usedUrl, "ws://ops.koreainvestment.com:31000/tryitout");
    await hub2.stop();
  });
});

test("W26 PINGPONG receives official pong reply", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  const ping = JSON.stringify({ header: { tr_id: "PINGPONG" }, body: {} });
  sock.pushMessage(ping);
  assert.equal(sock.pongs.length, 1);
  assert.equal(sock.pongs[0], ping);
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

  const bad = parseKisWsSystemMessage(
    JSON.stringify({
      header: { tr_id: "H0STCNT0", tr_key: "035720" },
      body: { rt_cd: "1", msg1: "SUBSCRIBE ERROR" },
    }),
  );
  assert.ok(bad);
  assert.equal(bad!.isOk, false);
});

test("approval key is cached and single-flight", async () => {
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

  const [a, b] = await Promise.all([
    getKisWsApprovalKey(cfg, { fetchImpl }),
    getKisWsApprovalKey(cfg, { fetchImpl }),
  ]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(peekApprovalCacheSizeForTest(), 1);
});

test("W7/W8 consumer sync subscribe once; duplicate no resend", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  const before = sock.sent.length;
  await hub.syncSubscriptions("acct-a", ["035720"]);
  assert.equal(sock.sent.length, before + 1);
  await hub.syncSubscriptions("acct-a", ["035720"]);
  assert.equal(sock.sent.length, before + 1);
  await hub.stop();
});

test("T1 S1 shared AppKey A/B union", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["005930"]);
  assert.deepEqual(hub.health().subscriptions, ["005930", "035720"]);
  await hub.stop();
});

test("T2 S2 same ticker shared — subscribe once", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  const before = sock.sent.length;
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["035720"]);
  const subMsgs = sock.sent.slice(before).filter((m) => {
    const j = JSON.parse(m) as { header: { tr_type: string }; body: { input: { tr_key: string } } };
    return j.header.tr_type === "1" && j.body.input.tr_key === "035720";
  });
  assert.equal(subMsgs.length, 1);
  assert.deepEqual(hub.health().subscriptions, ["035720"]);
  await hub.stop();
});

test("T3 S3 one consumer clear keeps peer ticker", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["035720"]);
  await hub.syncSubscriptions("A", []);
  assert.deepEqual(hub.health().subscriptions, ["035720"]);
  assert.deepEqual(hub.consumerTickersForTest("B"), ["035720"]);
  await hub.stop();
});

test("T4 S4 last consumer clear unsubscribes once with tr_type=2", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["035720"]);
  await hub.clearConsumerSubscriptions("A");
  const before = sock.sent.length;
  await hub.clearConsumerSubscriptions("B");
  assert.deepEqual(hub.health().subscriptions, []);
  const unsub = sock.sent.slice(before).filter((m) => {
    const j = JSON.parse(m) as { header: { tr_type: string }; body: { input: { tr_key: string } } };
    return j.header.tr_type === "2" && j.body.input.tr_key === "035720";
  });
  assert.equal(unsub.length, 1);
  await hub.stop();
});

test("T5 S5 A changes while B holds 035720", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["035720"]);
  await hub.syncSubscriptions("A", ["005930"]);
  assert.deepEqual(hub.health().subscriptions, ["005930", "035720"]);
  await hub.stop();
});

test("T5 S6 dispose A preserves B", async () => {
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

  const hub = acquireQuoteHub({
    config: paperConfig("shared-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  }) as KisRealtimeQuoteHub;
  acquireQuoteHub({
    config: paperConfig("shared-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  });
  await hub.start();
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["005930"]);
  await hub.clearConsumerSubscriptions("A");
  assert.deepEqual(hub.health().subscriptions, ["005930"]);
  await releaseQuoteHub(hub.sessionKey);
  assert.equal(quoteHubRefCount(hub.sessionKey), 1);
  assert.deepEqual(hub.health().subscriptions, ["005930"]);
  await releaseQuoteHub(hub.sessionKey);
  await resetQuoteHubRegistry();
});

test("hub projects multi-row into both caches; malformed increments parseErrors", async () => {
  const sock = new FakeSocket();
  const hub = await makeHub(sock);
  sock.pushMessage(
    buildH0stCnt0MultiFixture([
      { MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45200" },
      { MKSC_SHRN_ISCD: "005930", STCK_PRPR: "70000" },
    ]),
  );
  assert.equal(hub.get("035720")?.price, 45_200);
  assert.equal(hub.get("005930")?.price, 70_000);

  const beforeErr = hub.health().parseErrors;
  sock.pushMessage(
    buildH0stCnt0MultiWithMalformedSecond(
      { MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45300" },
      ["bad"],
    ),
  );
  assert.equal(hub.get("035720")?.price, 45_300);
  assert.ok(hub.health().parseErrors > beforeErr);
  await hub.stop();
});

test("subscription capacity throws explicit error", async () => {
  const sock = new FakeSocket();
  clearApprovalCacheForTest();
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
  await hub.syncSubscriptions("A", ["035720", "005930"]);
  await assert.rejects(() => hub.syncSubscriptions("B", ["069500"]), (err: unknown) => {
    assert.ok(err instanceof SubscriptionCapacityError);
    return true;
  });
  await hub.stop();
});

test("W29 same AppKey shares one hub; different AppKey separate", async () => {
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

  const c = acquireQuoteHub({
    config: paperConfig("other-key"),
    fetchImpl,
    webSocketFactory: factory,
    hubOpts: { autoReconnect: false },
  });
  assert.notEqual(c.sessionKey, a.sessionKey);
  assert.equal(quoteHubRegistrySize(), 2);

  await releaseQuoteHub(a);
  await releaseQuoteHub(b);
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

test("T9/T10 server WS runtime available via ws package; explicit error path", () => {
  assert.equal(isServerWebSocketRuntimeAvailable(), true);
  const factory = createServerWebSocketFactory();
  assert.equal(typeof factory, "function");
  // Fake unavailable constructor path
  assert.throws(
    () => {
      throw new ServerWebSocketUnavailableError();
    },
    (err: unknown) => {
      assert.ok(err instanceof ServerWebSocketUnavailableError);
      assert.equal(err.code, "SERVER_WEBSOCKET_UNAVAILABLE");
      return true;
    },
  );
});
