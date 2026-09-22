/**
 * Shared AppKey hub registry lifetime: one RuntimeScope = one acquire = one release.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getKisConfig } from "@/src/brokers/kis-config";
import {
  KisClient,
  setSharedKisClientForTest,
  resetSharedKisClient,
} from "@/src/brokers/kis-client";
import { clearApprovalCacheForTest } from "@/src/market-data/kis-approval";
import {
  KisRealtimeQuoteHub,
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
  acquirePaperQuoteHub,
  disposeScopeQuoteHub,
  peekPaperQuoteHub,
} from "@/src/market-data/ws-quote-feed";
import {
  createBootstrapRuntimeScope,
  invalidateRuntimeScope,
  resetRuntimeScopesForTest,
} from "@/src/runtime/runtime-scope";

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
}

function paperClient(appKey = "lifetime-shared-key") {
  return new KisClient(
    getKisConfig("paper", {
      KIS_PAPER_APP_KEY: appKey,
      KIS_PAPER_APP_SECRET: "lifetime-secret",
      KIS_PAPER_ACCOUNT_NO: "11111111-01",
    }),
  );
}

function factoryWith(sock: FakeSocket) {
  return () => {
    queueMicrotask(() => sock.open());
    return sock;
  };
}

const fetchImpl = (async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ approval_key: "lifetime-approval" }),
  }) as Response) as typeof fetch;

async function sharedHub(appKey: string, sock: FakeSocket) {
  return acquireQuoteHub({
    config: paperClient(appKey).wsConfig(),
    fetchImpl,
    webSocketFactory: factoryWith(sock),
    hubOpts: { autoReconnect: false },
  }) as KisRealtimeQuoteHub;
}

test.beforeEach(async () => {
  clearApprovalCacheForTest();
  resetRuntimeScopesForTest();
  await resetQuoteHubRegistry();
  resetSharedKisClient();
});

test.after(async () => {
  resetRuntimeScopesForTest();
  await resetQuoteHubRegistry();
  resetSharedKisClient();
});

test("R1/R2 same AppKey acquires bump refCount 1 → 2; same hub instance", () => {
  const client = paperClient();
  const a = acquirePaperQuoteHub(client);
  assert.ok(a);
  assert.equal(quoteHubRefCount(a!.sessionKey), 1);

  const b = acquirePaperQuoteHub(client);
  assert.ok(b);
  assert.equal(a, b);
  assert.equal(quoteHubRefCount(a!.sessionKey), 2);
});

test("R3-R5 dispose A keeps hub; dispose B stops once", async () => {
  const sock = new FakeSocket();
  const hub = await sharedHub("life-ab", sock);
  await sharedHub("life-ab", sock); // refCount 2
  await hub.start();
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["005930"]);
  assert.deepEqual(hub.health().subscriptions, ["005930", "035720"]);

  assert.equal(quoteHubRefCount(hub.sessionKey), 2);
  await disposeScopeQuoteHub(hub, "A");
  assert.equal(quoteHubRefCount(hub.sessionKey), 1);
  assert.notEqual(hub.health().state, "STOPPED");
  assert.deepEqual(hub.health().subscriptions, ["005930"]);
  assert.equal(sock.closed, false);

  await disposeScopeQuoteHub(hub, "B");
  assert.equal(quoteHubRefCount(hub.sessionKey), 0);
  assert.equal(hub.health().state, "STOPPED");
  assert.equal(quoteHubRegistrySize(), 0);
  assert.equal(sock.closed, true);
});

test("R6 shared ticker survives first consumer dispose", async () => {
  const sock = new FakeSocket();
  const hub = await sharedHub("life-same", sock);
  await sharedHub("life-same", sock);
  await hub.start();
  await hub.syncSubscriptions("A", ["035720"]);
  await hub.syncSubscriptions("B", ["035720"]);
  await disposeScopeQuoteHub(hub, "A");
  assert.deepEqual(hub.health().subscriptions, ["035720"]);
  assert.equal(hub.health().state, "CONNECTED");
  assert.equal(sock.closed, false);
  await disposeScopeQuoteHub(hub, "B");
});

test("R7 credential rotation for A leaves B hub alive; new A re-acquires", async () => {
  const sock = new FakeSocket();
  const appKey = "rotate-key";
  setSharedKisClientForTest(paperClient(appKey));

  // Seed registry with fake WS so bootstrap acquire reuses this hub (no real network).
  const seeded = await sharedHub(appKey, sock);
  await seeded.start();

  const boot = createBootstrapRuntimeScope(async () => undefined);
  assert.equal(boot.quoteHub, seeded);
  assert.equal(quoteHubRefCount(seeded.sessionKey), 2);

  await seeded.syncSubscriptions("bootstrap-owner", ["035720"]);
  await seeded.syncSubscriptions("acct-b", ["005930"]);

  invalidateRuntimeScope("bootstrap-owner");
  assert.equal(quoteHubRefCount(seeded.sessionKey), 1);
  // Allow async consumer clear to settle.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seeded.health().subscriptions, ["005930"]);
  assert.notEqual(seeded.health().state, "STOPPED");
  assert.equal(sock.closed, false);

  const boot2 = createBootstrapRuntimeScope(async () => undefined);
  assert.equal(boot2.quoteHub, seeded);
  assert.equal(quoteHubRefCount(seeded.sessionKey), 2);

  invalidateRuntimeScope("bootstrap-owner");
  await disposeScopeQuoteHub(seeded, "acct-b");
  assert.equal(quoteHubRegistrySize(), 0);
});

test("R8 resetRuntimeScopesForTest with shared hub — one remaining release cleans registry", async () => {
  const sock = new FakeSocket();
  const appKey = "reset-key";
  setSharedKisClientForTest(paperClient(appKey));
  const seeded = await sharedHub(appKey, sock);
  await seeded.start();

  const boot = createBootstrapRuntimeScope(async () => undefined);
  assert.equal(boot.quoteHub, seeded);
  assert.equal(quoteHubRefCount(seeded.sessionKey), 2);

  await seeded.syncSubscriptions("bootstrap-owner", ["035720"]);
  await seeded.syncSubscriptions("acct-b", ["005930"]);

  resetRuntimeScopesForTest(); // releases bootstrap acquire only
  assert.equal(quoteHubRefCount(seeded.sessionKey), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seeded.health().subscriptions, ["005930"]);

  await disposeScopeQuoteHub(seeded, "acct-b");
  assert.equal(quoteHubRegistrySize(), 0);
  assert.equal(quoteHubRefCount(seeded.sessionKey), 0);

  await releaseQuoteHub(seeded); // double release safe
  await resetQuoteHubRegistry();
  assert.equal(quoteHubRegistrySize(), 0);
});

test("peekPaperQuoteHub does not bump refCount; tick-safe", () => {
  const client = paperClient("peek-key");
  assert.equal(peekPaperQuoteHub(client), null);
  const hub = acquirePaperQuoteHub(client);
  assert.ok(hub);
  assert.equal(quoteHubRefCount(hub!.sessionKey), 1);
  assert.equal(peekPaperQuoteHub(client), hub);
  assert.equal(peekPaperQuoteHub(client), hub);
  assert.equal(quoteHubRefCount(hub!.sessionKey), 1);
});
