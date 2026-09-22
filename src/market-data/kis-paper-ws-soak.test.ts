/**
 * SOAK1–SOAK7: FakeSocket harness for read-only PAPER WS soak.
 * Never hits live KIS APIs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildH0stCnt0Fixture } from "@/src/market-data/h0stcnt0-fixture";
import { clearApprovalCacheForTest } from "@/src/market-data/kis-approval";
import {
  KisRealtimeQuoteHub,
  type WebSocketLike,
} from "@/src/market-data/kis-realtime-quote-hub";
import {
  acquireQuoteHub,
  quoteHubRefCount,
  resetQuoteHubRegistry,
} from "@/src/market-data/kis-realtime-registry";
import {
  assertReadOnlyPaperEnv,
  formatFinalReport,
  ReadOnlySoakGuardError,
  runPaperWsReadOnlySoak,
  WS_READONLY_SOAK_CONSUMER_ID,
} from "@/src/market-data/kis-paper-ws-soak";
import {
  inquirePriceRestCountForTest,
  resetInquirePriceRestCountForTest,
} from "@/src/brokers/kis-client";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  closed = false;
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
    this.closed = true;
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

function paperConfig(appKey = "soak-paper-key") {
  return {
    environment: "paper" as const,
    appKey,
    appSecret: "soak-paper-secret-DO-NOT-PRINT",
    host: "https://openapivts.koreainvestment.com:29443",
    websocketUrl: "ws://ops.koreainvestment.com:31000",
  };
}

const fetchImpl = (async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ approval_key: "soak-approval-secret-key" }),
  }) as Response) as typeof fetch;

async function makeRegisteredHub(
  sock: FakeSocket,
  appKey = "soak-paper-key",
  clock: { now: number } = { now: Date.now() },
) {
  return acquireQuoteHub({
    config: paperConfig(appKey),
    fetchImpl,
    webSocketFactory: () => {
      queueMicrotask(() => sock.open());
      return sock;
    },
    hubOpts: {
      autoReconnect: false,
      now: () => clock.now,
    },
  }) as KisRealtimeQuoteHub;
}

test.beforeEach(async () => {
  clearApprovalCacheForTest();
  await resetQuoteHubRegistry();
  resetInquirePriceRestCountForTest();
});

test.after(async () => {
  await resetQuoteHubRegistry();
});

test("SOAK1 harness does not mutate autoTrading / uses read-only consumer", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-paper-key", clock);
  const logs: string[] = [];
  const autoTradingBefore = true; // sentinel — harness must not touch store

  const report = await runPaperWsReadOnlySoak({
    hub,
    skipRegistryRelease: false,
    ticker: "035720",
    durationMs: 400,
    firstQuoteTimeoutMs: 10_000,
    healthIntervalMs: 10_000,
    summaryIntervalMs: 10_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      if (!sock.closed && clock.now - 1_700_000_000_000 > 50) {
        sock.pushMessage(buildH0stCnt0Fixture({ STCK_PRPR: "45200" }));
      }
    },
    log: (line) => logs.push(line),
    env: {
      KIS_MODE: "paper",
      ALLOW_LIVE_TRADING: "false",
      TRADING_MODE: "live_test",
    },
  });

  assert.equal(report.autoTradingMutations, 0);
  assert.equal(report.autoTradingMutation, "NONE");
  assert.equal(autoTradingBefore, true);
  assert.ok(hub.consumerTickersForTest(WS_READONLY_SOAK_CONSUMER_ID).length === 0);
  assert.equal(report.final.readyForPaperAutomatedMarketTest, "NO");
});

test("SOAK2 order API and inquirePrice remain 0", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-order-zero", clock);
  const before = inquirePriceRestCountForTest();

  const report = await runPaperWsReadOnlySoak({
    hub,
    ticker: "035720",
    durationMs: 300,
    firstQuoteTimeoutMs: 10_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      sock.pushMessage(buildH0stCnt0Fixture());
    },
    log: () => {},
    env: { KIS_MODE: "paper", ALLOW_LIVE_TRADING: "false" },
    inquirePriceBaseline: before,
  });

  assert.equal(report.domesticOrders, 0);
  assert.equal(report.overseasOrders, 0);
  assert.equal(report.restInquirePricePolling, 0);
  assert.equal(inquirePriceRestCountForTest(), before);
  assert.equal(report.final.readOnlySoak, "PASS");
});

test("SOAK3 first H0STCNT0 quote yields live-data PASS", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-first-quote", clock);

  const report = await runPaperWsReadOnlySoak({
    hub,
    ticker: "035720",
    durationMs: 500,
    firstQuoteTimeoutMs: 10_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      sock.pushMessage(
        buildH0stCnt0Fixture({
          MKSC_SHRN_ISCD: "035720",
          STCK_PRPR: "46100",
          BIDP1: "46050",
          ASKP1: "46150",
        }),
      );
    },
    log: () => {},
    env: { KIS_MODE: "paper" },
  });

  assert.equal(report.firstQuoteReceived, true);
  assert.equal(report.quotesReceived >= 1, true);
  assert.equal(report.lastPrice, 46_100);
  assert.equal(report.final.h0stcnt0LiveData, "PASS");
  assert.equal(report.final.actualKisPaperConnection, "PASS");
  assert.equal(report.final.freshQuoteStream, "PASS");
});

test("SOAK4 connected but no quote is not PASS", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-no-quote", clock);

  const report = await runPaperWsReadOnlySoak({
    hub,
    ticker: "035720",
    durationMs: 5_000,
    firstQuoteTimeoutMs: 800,
    healthIntervalMs: 50_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      // connected, but never push H0STCNT0
    },
    log: () => {},
    env: { KIS_MODE: "demo" },
  });

  assert.equal(report.connected, true);
  assert.equal(report.firstQuoteReceived, false);
  assert.equal(report.failReason, "WS_CONNECTED_BUT_NO_QUOTE");
  assert.equal(report.final.h0stcnt0LiveData, "FAIL");
  assert.equal(report.final.freshQuoteStream, "FAIL");
  assert.equal(report.final.readyForPaperAutomatedMarketTest, "NO");
});

test("SOAK5 consumer cleanup preserves peer Hub reference", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-peer", clock);
  // peer RuntimeScope ref
  await acquireQuoteHub({
    config: paperConfig("soak-peer"),
    fetchImpl,
    webSocketFactory: () => sock,
    hubOpts: { autoReconnect: false, now: () => clock.now },
  });
  assert.equal(quoteHubRefCount(hub.sessionKey), 2);

  await hub.start();
  await hub.syncSubscriptions("peer-runtime", ["005930"]);

  await runPaperWsReadOnlySoak({
    hub,
    skipRegistryRelease: false,
    ticker: "035720",
    durationMs: 300,
    firstQuoteTimeoutMs: 10_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      sock.pushMessage(buildH0stCnt0Fixture());
    },
    log: () => {},
    env: { KIS_MODE: "paper" },
  });

  assert.equal(quoteHubRefCount(hub.sessionKey), 1);
  assert.notEqual(hub.health().state, "STOPPED");
  assert.equal(sock.closed, false);
  assert.deepEqual(hub.consumerTickersForTest("peer-runtime"), ["005930"]);
  assert.deepEqual(hub.consumerTickersForTest(WS_READONLY_SOAK_CONSUMER_ID), []);
  assert.deepEqual(hub.health().subscriptions, ["005930"]);

  await resetQuoteHubRegistry();
});

test("SOAK6 timeout/shutdown cleanup clears consumer", async () => {
  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-shutdown", clock);
  const ac = new AbortController();

  const run = runPaperWsReadOnlySoak({
    hub,
    ticker: "035720",
    durationMs: 60_000,
    firstQuoteTimeoutMs: 60_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now - 1_700_000_000_000 > 200) ac.abort();
    },
    signal: ac.signal,
    log: () => {},
    env: { KIS_MODE: "paper" },
  });

  const report = await run;
  assert.ok(report.failReason === "ABORTED" || report.firstQuoteReceived === false);
  assert.deepEqual(hub.consumerTickersForTest(WS_READONLY_SOAK_CONSUMER_ID), []);
  assert.equal(quoteHubRefCount(hub.sessionKey), 0);
});

test("SOAK7 secret logging absent + env guards", async () => {
  assert.throws(
    () => assertReadOnlyPaperEnv({ KIS_MODE: "real" }),
    (err: unknown) => err instanceof ReadOnlySoakGuardError && err.code === "KIS_MODE_NOT_PAPER",
  );
  assert.throws(
    () => assertReadOnlyPaperEnv({ KIS_MODE: "paper", ALLOW_LIVE_TRADING: "true" }),
    (err: unknown) => err instanceof ReadOnlySoakGuardError && err.code === "ALLOW_LIVE_TRADING",
  );
  assert.throws(
    () => assertReadOnlyPaperEnv({ KIS_MODE: "paper", TRADING_MODE: "live" }),
    (err: unknown) => err instanceof ReadOnlySoakGuardError && err.code === "TRADING_MODE_LIVE",
  );
  assert.throws(
    () =>
      assertReadOnlyPaperEnv({
        KIS_MODE: "paper",
        KIS_LIVE_CONFIRM: "I_UNDERSTAND",
      }),
    (err: unknown) => err instanceof ReadOnlySoakGuardError && err.code === "KIS_LIVE_CONFIRM",
  );

  const sock = new FakeSocket();
  const clock = { now: 1_700_000_000_000 };
  const hub = await makeRegisteredHub(sock, "soak-secrets", clock);
  const logs: string[] = [];

  const report = await runPaperWsReadOnlySoak({
    hub,
    ticker: "035720",
    durationMs: 300,
    firstQuoteTimeoutMs: 10_000,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      sock.pushMessage(buildH0stCnt0Fixture());
    },
    log: (line) => logs.push(line),
    env: { KIS_MODE: "paper" },
  });

  const joined = logs.join("\n") + "\n" + formatFinalReport(report);
  assert.equal(joined.includes("soak-paper-secret"), false);
  assert.equal(joined.includes("soak-approval-secret"), false);
  assert.equal(joined.includes("approval_key"), false);
  assert.equal(joined.includes("appSecret"), false);
  assert.equal(joined.includes("appKey"), false);
  assert.match(joined, /SessionKey fingerprint:/);
  assert.match(joined, /Ready For PAPER Automated Market Test:\nNO/);

  // Source ban: soak modules must not call order / tick APIs
  const harnessSrc = readFileSync(
    path.join(process.cwd(), "src/market-data/kis-paper-ws-soak.ts"),
    "utf8",
  );
  const scriptSrc = readFileSync(path.join(process.cwd(), "scripts/kis-paper-ws-soak.ts"), "utf8");
  for (const banned of [
    "orderCash",
    "cancelOrder",
    "buyMarket",
    "buyLimit",
    "sellMarket",
    "sellLimit",
    "tickState",
    "tickAndGet",
    "inquirePrice(",
    "mutateStore",
  ]) {
    assert.equal(harnessSrc.includes(banned), false, `harness must not contain ${banned}`);
    assert.equal(scriptSrc.includes(banned), false, `script must not contain ${banned}`);
  }
  assert.equal(/autoTrading\s*=/.test(harnessSrc), false);
  assert.equal(/autoTrading\s*=/.test(scriptSrc), false);
});
