import type { AppState, Order, Position } from "@/lib/types";
import type { StateBox } from "@/src/accounts/StateBox";
import type { KisAccountBalance, KisApi, KisDayOrder } from "@/src/brokers/kis-client";
import { padOdno, sameOdno } from "@/src/brokers/kis-client";
import { loadKisConfig, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { nowIso } from "@/src/clock";
import { patchOrder, bookReportedFill } from "@/src/accounts/fills";
import { CASH_RULE_ID } from "@/src/rules/params";
import { findStock } from "@/lib/universe";
import { patchIntent, upsertIntent } from "@/src/runtime/intents";
import { recordPending } from "@/src/accounts/fills";
import { clearSafetyBlock, safetyOf } from "@/src/runtime/safety";
import { isRecoverableInquiryHalt } from "@/src/runtime/controlled-run";
import { tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { isNodeTestProcess } from "@/src/runtime/test-process";
import {
  snapshotFromBrokerBalance,
  usesPaperBrokerBalanceSemantics,
} from "@/src/risk/kis-balance-semantics";
import { diffLocalVsKis } from "@/src/risk/balance-sync";
import { HARD_LIMITS } from "@/src/risk/limits";

async function inquireOrFail<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "증권사 조회에 실패했습니다." };
  }
}

export type ActiveOrderClass =
  | "ACTIVE_MATCHED"
  | "HISTORICAL_MATCHED"
  | "ORPHANED_LOCAL"
  | "UNKNOWN_ACTIVE";

export type StartupSyncStatus = "IDLE" | "SYNCING" | "HEALTHY" | "FAILED";

export type StartupSyncState = {
  status: StartupSyncStatus;
  lastSyncedAt?: string;
  recoveredOrders: number;
  orphanedOrders: number;
  positionChanges: number;
  executionChanges: number;
  message?: string;
};

export function emptyStartupSync(): StartupSyncState {
  return {
    status: "IDLE",
    recoveredOrders: 0,
    orphanedOrders: 0,
    positionChanges: 0,
    executionChanges: 0,
  };
}

/** LIVE_TEST + KIS PAPER only. Never REAL. */
export function usesPaperStartupSync(env: EnvMap = process.env): boolean {
  if (tradingMode(env) !== "live_test") return false;
  if (env.BROKER !== "kis") return false;
  const mode = String(env.KIS_MODE ?? "").trim().toLowerCase();
  if (mode !== "paper" && mode !== "demo") return false;
  if (env.ALLOW_LIVE_TRADING === "true") return false;
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") return false;
  if (String(env.TRADING_MODE ?? "").trim().toLowerCase() === "live") return false;
  try {
    if (resolveKisEnvironment(env) !== "paper") return false;
    if (loadKisConfig(env).environment !== "paper") return false;
  } catch {
    return false;
  }
  return true;
}

export function seoulDayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

export function seoulToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

function padTicker(code: string): string {
  return code.replace(/\D/g, "").slice(-6).padStart(6, "0");
}

export function inferOrderProvenance(order: Order): string {
  if (order.provenance) return order.provenance;
  const reason = order.reason ?? "";
  const intent = order.intentId ?? "";
  const blob = `${reason} ${intent} ${order.sourceId ?? ""}`;
  if (/RECOVERED_ORDER/i.test(reason) || intent.startsWith("recovered:")) return "RECOVERED_ORDER";
  if (/VTS|TEST_FIXTURE|sig:paper:dup|FakeKis|ORDER TEST/i.test(blob)) {
    return "VTS_TEST";
  }
  if (/LEGACY|fixture|테스트/i.test(reason)) return "LEGACY_LOCAL";
  if (order.brokerOrderNo && order.status === "filled") return "BROKER_CONFIRMED";
  // Do not default to LEGACY_LOCAL — today's unconfirmed orders must stay UNKNOWN_ACTIVE.
  return "UNCONFIRMED";
}

function isHistoricalOrTestProvenance(provenance: string): boolean {
  return (
    provenance === "VTS_TEST" ||
    provenance === "LEGACY_LOCAL" ||
    provenance === "TEST_FIXTURE"
  );
}

/** Active trading blockers only — orphaned/historical do not block. */
export function isActiveUnknownBlocker(order: Order): boolean {
  if (order.parentOrderId) return false;
  if (order.activeClass === "ORPHANED_LOCAL" || order.activeClass === "HISTORICAL_MATCHED") {
    return false;
  }
  if (order.activeClass === "UNKNOWN_ACTIVE") return true;
  if (order.status === "unknown") return true;
  if (order.status === "pending" && !order.brokerOrderNo) return true;
  return false;
}

export function findActiveUnknownOrder(state: AppState): Order | undefined {
  return state.orders.find((order) => isActiveUnknownBlocker(order));
}

export function mergeRemoteOrders(open: KisDayOrder[], daily: KisDayOrder[]): KisDayOrder[] {
  const byNo = new Map<string, KisDayOrder>();
  for (const row of [...open, ...daily]) {
    if (!row.orderNo) continue;
    const key = padOdno(row.orderNo);
    const prev = byNo.get(key);
    if (!prev || row.filledQty > prev.filledQty) byNo.set(key, row);
  }
  return [...byNo.values()];
}

export function classifyLocalActiveOrder(
  order: Order,
  remote: KisDayOrder[],
  now = new Date(),
): { classification: ActiveOrderClass; reason: string; remote?: KisDayOrder } {
  const match = order.brokerOrderNo
    ? remote.find((row) => sameOdno(row.orderNo, order.brokerOrderNo))
    : undefined;

  if (match) {
    if (match.unfilledQty > 0) {
      return {
        classification: "ACTIVE_MATCHED",
        reason: "현재 KIS PAPER open/daily 상태에서 exact ODNO를 확인했습니다.",
        remote: match,
      };
    }
    return {
      classification: "HISTORICAL_MATCHED",
      reason: "KIS PAPER에서 exact ODNO 체결/종료 evidence를 확인했습니다.",
      remote: match,
    };
  }

  const orderDay = seoulDayOf(order.createdAt);
  const today = seoulToday(now);
  const provenance = inferOrderProvenance(order);
  const pastDay = orderDay < today;

  // Past calendar day (KST) without today's ODNO → orphaned history, not UNKNOWN_ACTIVE.
  // Explicit test/legacy provenance may orphan even on the same day.
  if (pastDay || isHistoricalOrTestProvenance(provenance)) {
    return {
      classification: "ORPHANED_LOCAL",
      reason:
        pastDay
          ? `과거 로컬 주문(${orderDay})이며 현재 KIS PAPER 당일/미체결 조회에 ODNO가 없습니다. 기록은 보존되며 현재 PAPER 거래에는 영향을 주지 않습니다.`
          : `과거 로컬 테스트 주문으로 분류되었습니다. 기록은 보존되며 현재 PAPER 거래에는 영향을 주지 않습니다. (${provenance})`,
    };
  }

  return {
    classification: "UNKNOWN_ACTIVE",
    reason:
      "현재 PAPER 주문 상태를 확인할 수 없어 신규 주문을 차단했습니다. 자동 재주문하지 않습니다.",
  };
}

/**
 * Align runtime positions to KIS holdings. Does not invent executions/trades.
 * Removes local-only active qty; adds/updates from broker.
 */
export function syncRuntimePositionsFromBroker(
  state: AppState,
  remote: KisAccountBalance,
): { state: AppState; changes: number } {
  const fallback =
    [...state.allocations].sort((a, b) => b.budget - a.budget)[0]?.ruleId ?? CASH_RULE_ID;
  const next: Position[] = remote.holdings
    .filter((row) => row.qty > 0)
    .map((row) => {
      const code = padTicker(row.ticker);
      const prev = state.positions.find((pos) => padTicker(pos.code) === code);
      return {
        code,
        name: row.name || prev?.name || findStock(code)?.name || code,
        qty: row.qty,
        avgPrice: row.avgPrice > 0 ? row.avgPrice : (prev?.avgPrice ?? 0),
        ruleId: prev?.ruleId ?? fallback,
      };
    });

  const before = new Map(
    state.positions.filter((p) => p.qty > 0).map((p) => [padTicker(p.code), p.qty]),
  );
  const after = new Map(next.map((p) => [padTicker(p.code), p.qty]));
  const keys = new Set([...before.keys(), ...after.keys()]);
  let changes = 0;
  for (const key of keys) {
    if ((before.get(key) ?? 0) !== (after.get(key) ?? 0)) changes += 1;
  }

  return { state: { ...state, positions: next }, changes };
}

function alreadyTracked(state: AppState, orderNo: string): Order | undefined {
  return state.orders.find((row) => sameOdno(row.brokerOrderNo, orderNo));
}

function adoptRemote(box: StateBox, row: KisDayOrder): void {
  if (!row.orderNo) return;
  if (alreadyTracked(box.current, row.orderNo)) return;
  const stock = findStock(row.ticker);
  const fallback =
    [...box.current.allocations].sort((a, b) => b.budget - a.budget)[0]?.ruleId ?? CASH_RULE_ID;
  const intentId = `recovered:${row.orderNo}`;
  const committed = upsertIntent(box.current, {
    intentId,
    signalId: intentId,
    ruleId: fallback,
    ticker: row.ticker,
    side: row.side,
    qty: row.qty,
    price: row.avgPrice || 0,
    reason: "RECOVERED_ORDER",
  });
  const started = recordPending(committed.state, {
    intentId,
    source: "rule",
    ruleId: fallback,
    code: row.ticker,
    name: stock?.name ?? row.ticker,
    side: row.side,
    qty: row.qty,
    price: row.avgPrice || 1,
    ordDvsn: "limit",
  });
  const withNo = patchOrder(started.state, started.order.id, {
    status: row.unfilledQty > 0 ? "pending" : "pending",
    brokerOrderNo: row.orderNo,
    reason: "RECOVERED_ORDER · 증권사 주문을 로컬에 편입했습니다.",
    orderedQty: row.qty,
    filledQty: 0,
    activeClass: row.unfilledQty > 0 ? "ACTIVE_MATCHED" : "HISTORICAL_MATCHED",
    provenance: "RECOVERED_ORDER",
  });
  box.current = patchIntent(withNo.state, intentId, {
    status: "submitted",
    orderId: started.order.id,
    brokerOrderNo: row.orderNo,
  });
  if (row.filledQty > 0) {
    const booked = bookReportedFill(box.current, started.order.id, {
      filledQty: row.filledQty,
      avgPrice: row.avgPrice,
      brokerOrderNo: row.orderNo,
    });
    box.current = booked.state;
  }
}

export type StartupSyncResult = {
  ok: boolean;
  state: AppState;
  error?: string;
  classifications: Array<{ orderId: string; classification: ActiveOrderClass; reason: string }>;
};

/**
 * Fetch KIS PAPER current state and classify local active orders.
 * Preserves historical ledger rows. Does not place orders.
 */
export async function runPaperStartupSync(
  state: AppState,
  client: KisApi,
  env: EnvMap = process.env,
  now = new Date(),
): Promise<StartupSyncResult> {
  if (!usesPaperStartupSync(env)) {
    return {
      ok: true,
      state: {
        ...state,
        startupSync: {
          ...(state.startupSync ?? emptyStartupSync()),
          status: "HEALTHY",
          lastSyncedAt: nowIso(),
          message: "Startup sync not required outside LIVE_TEST KIS PAPER",
        },
      },
      classifications: [],
    };
  }

  let next: AppState = {
    ...state,
    startupSync: {
      ...(state.startupSync ?? emptyStartupSync()),
      status: "SYNCING",
      message: "KIS PAPER current broker state sync in progress",
    },
  };

  if (!client.configured) {
    return {
      ok: false,
      state: {
        ...next,
        startupSync: {
          ...emptyStartupSync(),
          status: "FAILED",
          lastSyncedAt: nowIso(),
          message: "KIS PAPER client not configured",
        },
      },
      error: "KIS PAPER client not configured",
      classifications: [],
    };
  }

  const open = await inquireOrFail(() => client.inquireOpenOrders());
  if (!open.ok) {
    return failSync(next, open.error);
  }
  const daily = await inquireOrFail(() => client.inquireDailyCcld());
  if (!daily.ok) {
    return failSync(next, daily.error);
  }
  const balance = await inquireOrFail(() => client.inquireBalance());
  if (!balance.ok) {
    return failSync(next, balance.error);
  }

  const remote = mergeRemoteOrders(open.value, daily.value);
  const classifications: StartupSyncResult["classifications"] = [];
  let orphanedOrders = 0;
  let recoveredOrders = 0;
  let executionChanges = 0;

  const box: StateBox = { current: next };

  const activeLocals = box.current.orders.filter(
    (order) =>
      !order.parentOrderId && (order.status === "pending" || order.status === "unknown"),
  );

  for (const local of activeLocals) {
    const result = classifyLocalActiveOrder(local, remote, now);
    classifications.push({
      orderId: local.id,
      classification: result.classification,
      reason: result.reason,
    });
    const provenance = inferOrderProvenance(local);

    if (result.classification === "ACTIVE_MATCHED" && result.remote) {
      const patched = patchOrder(box.current, local.id, {
        status: "pending",
        brokerOrderNo: result.remote.orderNo,
        activeClass: "ACTIVE_MATCHED",
        provenance: "BROKER_CONFIRMED",
        reason: result.reason,
      });
      if (patched.order) box.current = patched.state;
      continue;
    }

    if (result.classification === "HISTORICAL_MATCHED" && result.remote) {
      let working = patchOrder(box.current, local.id, {
        activeClass: "HISTORICAL_MATCHED",
        provenance: "BROKER_CONFIRMED",
        reason: result.reason,
        brokerOrderNo: result.remote.orderNo,
      }).state;
      if (result.remote.filledQty > 0 && local.status !== "filled") {
        const booked = bookReportedFill(working, local.id, {
          filledQty: result.remote.filledQty,
          avgPrice: result.remote.avgPrice || local.price,
          brokerOrderNo: result.remote.orderNo,
        });
        working = booked.state;
        executionChanges += 1;
      } else {
        const closed = patchOrder(working, local.id, {
          status: result.remote.unfilledQty > 0 ? "pending" : "cancelled",
          reason: result.reason,
          activeClass: "HISTORICAL_MATCHED",
        });
        if (closed.order) working = closed.state;
      }
      box.current = working;
      continue;
    }

    if (result.classification === "ORPHANED_LOCAL") {
      orphanedOrders += 1;
      const patched = patchOrder(box.current, local.id, {
        activeClass: "ORPHANED_LOCAL",
        provenance,
        reason: result.reason,
        // Keep row; do not delete. Status may stay unknown for history.
      });
      if (patched.order) box.current = patched.state;
      continue;
    }

    const patched = patchOrder(box.current, local.id, {
      status: "unknown",
      activeClass: "UNKNOWN_ACTIVE",
      provenance,
      reason: result.reason,
    });
    if (patched.order) box.current = patched.state;
  }

  for (const row of remote) {
    if (!row.orderNo || alreadyTracked(box.current, row.orderNo)) continue;
    adoptRemote(box, row);
    recoveredOrders += 1;
  }

  const pos = syncRuntimePositionsFromBroker(box.current, balance.value);
  box.current = pos.state;

  let psbl;
  try {
    if (client.inquirePsblOrder) {
      const ticker = balance.value.holdings[0]?.ticker ?? "005930";
      const price = box.current.quotes[padTicker(ticker)]?.price || 1;
      psbl = await client.inquirePsblOrder({ ticker: padTicker(ticker), price });
    }
  } catch {
    psbl = undefined;
  }

  const paper = usesPaperBrokerBalanceSemantics(env);
  const diff = paper
    ? { cashDelta: box.current.cash - balance.value.cash, matched: true, message: "PAPER startup: positions synced to KIS; local ledger cash not compared to dnca." }
    : (() => {
        const d = diffLocalVsKis(box.current, balance.value, HARD_LIMITS.balanceCashToleranceKrw, env);
        return {
          cashDelta: d.cashDelta,
          matched: d.matched,
          message: d.matched ? "KIS 잔고와 로컬 포지션이 일치합니다." : d.reasons.join(" · "),
        };
      })();

  // After position sync, recompute matched for PAPER on positions only.
  if (paper) {
    const afterDiff = diffLocalVsKis(box.current, balance.value, HARD_LIMITS.balanceCashToleranceKrw, env);
    diff.matched = afterDiff.positionMatched;
    diff.message = afterDiff.positionMatched
      ? "PAPER startup sync: KIS positions match runtime active positions."
      : afterDiff.reasons.join(" · ");
  }

  box.current = {
    ...box.current,
    lastBalanceSyncAt: now.getTime(),
    kisBalance: snapshotFromBrokerBalance(balance.value, diff, now.getTime(), psbl),
  };

  const activeUnknown = findActiveUnknownOrder(box.current);
  if (activeUnknown) {
    return {
      ok: false,
      state: {
        ...box.current,
        startupSync: {
          status: "FAILED",
          lastSyncedAt: nowIso(),
          recoveredOrders,
          orphanedOrders,
          positionChanges: pos.changes,
          executionChanges,
          message: activeUnknown.reason ?? "UNKNOWN_ACTIVE remains after startup sync",
        },
      },
      error: activeUnknown.reason ?? "UNKNOWN_ACTIVE",
      classifications,
    };
  }

  // Clear only recoverable inquiry-related circuits that Startup Sync itself resolves.
  // Preserve kill / daily-loss / soak-stop / unknown-active ownership.
  const prevSafety = safetyOf(box.current);
  const clearedCircuit = isRecoverableInquiryHalt(box.current)
    ? {
        halted: false as const,
        kind: undefined,
        unknownCount: box.current.circuit?.unknownCount ?? 0,
      }
    : box.current.circuit;

  let healthy = clearSafetyBlock(
    {
      ...box.current,
      circuit: clearedCircuit ?? { halted: false, unknownCount: 0 },
      startupSync: {
        status: "HEALTHY",
        lastSyncedAt: nowIso(),
        recoveredOrders,
        orphanedOrders,
        positionChanges: pos.changes,
        executionChanges,
        message: "KIS PAPER current broker state synced. Historical ledger preserved.",
      },
    },
    {
      quoteOk: prevSafety.quoteOk,
      brokerConnected: true,
      reconciliation: diff.matched ? "synced" : "mismatch",
      workerHealthy: true,
    },
  );

  if (!diff.matched) {
    healthy = {
      ...healthy,
      startupSync: {
        ...(healthy.startupSync ?? emptyStartupSync()),
        status: "FAILED",
        message: `Position/balance mismatch after sync: ${diff.message}`,
      },
    };
    return { ok: false, state: healthy, error: diff.message, classifications };
  }

  return { ok: true, state: healthy, classifications };
}

function failSync(state: AppState, error: string): StartupSyncResult {
  return {
    ok: false,
    state: {
      ...state,
      startupSync: {
        ...(state.startupSync ?? emptyStartupSync()),
        status: "FAILED",
        lastSyncedAt: nowIso(),
        message: error,
      },
    },
    error,
    classifications: [],
  };
}

/** Process-local: THIS Node process completed a fresh KIS Startup Sync. */
let processBootStartupVerified = isNodeTestProcess();

export function isProcessBootStartupVerified(): boolean {
  return processBootStartupVerified;
}

export function markProcessBootStartupVerified(done = true): void {
  processBootStartupVerified = done;
}

export function resetProcessBootStartupForTest(): void {
  // Unit tests default to verified so existing PAPER policy suites stay focused.
  // R1 / boot-sync suites explicitly set false before asserting.
  processBootStartupVerified = isNodeTestProcess();
}

export function startupSyncBlocksTrading(
  state: AppState,
  env: EnvMap = process.env,
  opts: { bootVerified?: boolean } = {},
): string | null {
  if (!usesPaperStartupSync(env)) return null;
  const sync = state.startupSync;
  // FAILED is always authoritative — do not hide behind process-boot message.
  if (sync?.status === "FAILED") {
    const detail = sync.message?.trim();
    return detail
      ? `Startup Sync FAILED — ${detail} 신규 주문을 차단합니다.`
      : "Startup Sync FAILED — 신규 주문을 차단합니다.";
  }
  // Account runtime must pass bootVerified explicitly; bootstrap uses process flag.
  const bootVerified =
    opts.bootVerified !== undefined ? opts.bootVerified : processBootStartupVerified;
  // Persisted HEALTHY is historical — this process/account must still fresh-sync.
  if (!bootVerified) {
    return opts.bootVerified !== undefined
      ? "Account Startup Sync가 끝나기 전에는 신규 주문을 하지 않습니다."
      : "Process boot Startup Sync가 끝나기 전에는 신규 주문을 하지 않습니다.";
  }
  if (!sync || sync.status === "IDLE" || sync.status === "SYNCING") {
    return "Startup Sync가 끝나기 전에는 신규 주문을 하지 않습니다.";
  }
  return null;
}
