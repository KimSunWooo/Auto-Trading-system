import { roundToTick, tickSize } from "./tick-size";
import type { AppState, AutoCondition, DcaPlan, Quote } from "./types";
import { findStock } from "./universe";
import { getMarketClock } from "./market-hours";
import { canFillLimit } from "@/src/accounts/fills";
import { cashFromAllocations, DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { accountValue } from "@/src/accounts/portfolio";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker, BrokerNotReadyError, type CreateBrokerOpts } from "@/src/brokers/index";
import type { IBroker } from "@/src/brokers/IBroker";
import { QuantEngine } from "@/src/engine/QuantEngine";
import { emptyCircuit, tradingBlocked } from "@/src/risk/circuit";
import { HARD_LIMITS, seoulDay } from "@/src/risk/limits";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import { RiskManager } from "@/src/risk/RiskManager";
import { expireStaleInFlight, settleOpenOrders } from "@/src/risk/reconcile";
import { syncKisBalance } from "@/src/risk/balance-sync";
import { getSharedKisClient, type KisApi } from "@/src/brokers/kis-client";
import { watchedTickersFrom } from "@/src/rules/config";
import { autoRunAllowed } from "@/src/rules/disclaimer";
import { CASH_RULE_ID, type RuleConfigFile } from "@/src/rules/params";
import { guardLog } from "@/src/rules/guard-log";
import { emptySafety, safetyOf, clearSafetyBlock } from "@/src/runtime/safety";
import { isLiveLike } from "@/src/runtime/trading-mode";
import { recoverExternalOrders, markInquiryFailure, resetRecoverableHalt } from "@/src/runtime/recovery";
import { makeSignalId } from "@/src/runtime/intents";
import { nowMs } from "@/src/clock";
import { engineReconciliationFlag } from "@/src/risk/kis-balance-semantics";
import {
  applyAutoStop,
  autoStopReason,
  bumpTick,
  noteInquiry,
  noteQuoteResult,
  reconStatusOf,
  resumeTransientUnknownStop,
  syncHttpAudit,
} from "@/src/runtime/controlled-run";
import { startupSyncBlocksTrading, usesPaperStartupSync } from "@/src/runtime/startup-sync";
import { invalidateNonKisQuotes } from "@/src/runtime/quote-policy";
import {
  refreshQuotesFromWebSocket,
  peekPaperQuoteHub,
  syncWatchedSubscriptions,
} from "@/src/market-data/ws-quote-feed";
import type { RealtimeQuoteHub } from "@/src/market-data/kis-realtime-quote-hub";
import { SubscriptionCapacityError } from "@/src/market-data/kis-realtime-quote-hub";

const HISTORY_LEN = 40;

export { applyFill, canFillLimit, feeBreakdown, findPosition } from "@/src/accounts/fills";

/** @deprecated Removed from production — use makeTestQuote from src/test-support. */
export function seedQuote(code: string, _prevClose = 10_000, _name?: string): Quote {
  throw new Error(
    `seedQuote(${code}) removed from production runtime — use makeTestQuote in tests`,
  );
}

export function createInitialQuotes(): Record<string, Quote> {
  return {};
}

export function createInitialState(): AppState {
  const allocations = DEFAULT_ALLOCATIONS.map((row) => ({ ...row }));
  return {
    updatedAt: new Date().toISOString(),
    tickCount: 0,
    settings: {
      ignoreMarketHours: false,
      startingCash: TOTAL_DEPOSIT,
      broker: "kis",
      autoTrading: false,
      onboardingComplete: false,
      liquidating: false,
      disclaimerAccepted: false,
      risk: { ...DEFAULT_PRODUCT_RISK },
    },
    totalDeposit: TOTAL_DEPOSIT,
    allocations,
    cash: cashFromAllocations(allocations),
    positions: [],
    quotes: {},
    conditions: [],
    dcaPlans: [],
    orders: [],
    circuit: emptyCircuit(),
    dayStart: { date: seoulDay(), equity: TOTAL_DEPOSIT },
    equityHistory: [TOTAL_DEPOSIT],
    intents: [],
    safety: emptySafety(),
  };
}

/** Unit-test helper — builds a consented state with KIS-sourced fixture quotes. Prefer makeTestPaperState. */
export function createPaperState(): AppState {
  const state = createInitialState();
  state.settings.disclaimerAccepted = true;
  state.settings.autoTrading = true;
  state.settings.ignoreMarketHours = true;
  const mk = (code: string, prev: number): Quote => {
    const stock = findStock(code);
    const price = roundToTick(stock?.prevClose ?? prev);
    const tick = tickSize(price);
    return {
      code,
      name: stock?.name ?? code,
      market: stock?.market ?? "KOSPI",
      price,
      prevClose: stock?.prevClose ?? price,
      open: price,
      high: price,
      low: price,
      volume: 1,
      bid: roundToTick(Math.max(tick, price - tick)),
      ask: roundToTick(price + tick),
      history: Array.from({ length: HISTORY_LEN }, () => price),
      source: "kis",
      transport: "ws",
      freshAt: Date.now(),
    };
  };
  state.quotes = {
    "005930": mk("005930", 74_800),
    "035720": mk("035720", 42_150),
    "247540": mk("247540", 142_700),
  };
  state.cash = 10_000_000;
  state.totalDeposit = 10_000_000;
  state.allocations = [
    {
      ruleId: CASH_RULE_ID,
      budget: 10_000_000,
      balance: 10_000_000,
      enabled: true,
      lastMessage: "test fixture strategy cash",
    },
  ];
  state.dayStart = { date: seoulDay(), equity: 10_000_000 };
  state.equityHistory = [10_000_000];
  state.startupSync = {
    status: "HEALTHY",
    lastSyncedAt: new Date().toISOString(),
    recoveredOrders: 0,
    orphanedOrders: 0,
    positionChanges: 0,
    executionChanges: 0,
    message: "test fixture",
  };
  return state;
}

/** Drop mock/seed; never invent prices. KIS WS is the only quote authority. */
export function ensureUniverseQuotes(state: AppState): AppState {
  return { ...state, quotes: invalidateNonKisQuotes(state.quotes) };
}

/** @deprecated Production never synthesizes mock prices. */
export function advanceQuotes(
  quotes: Record<string, Quote>,
  _rng: () => number = Math.random,
): Record<string, Quote> {
  return invalidateNonKisQuotes(quotes);
}

export function watchPrice(quote: Quote, cond: AutoCondition): number {
  if (cond.watchBasis === "bid") return quote.bid;
  if (cond.watchBasis === "ask") return quote.ask;
  return quote.price;
}

export function conditionMatches(cond: AutoCondition, quote: Quote): boolean {
  const price = watchPrice(quote, cond);
  const priceOk =
    cond.operator === "gte" ? price >= cond.triggerPrice : price <= cond.triggerPrice;
  if (!priceOk) return false;
  if (!cond.volumeEnabled) return true;
  return cond.volumeOp === "gte"
    ? quote.volume >= cond.volume
    : quote.volume <= cond.volume;
}

function watchedTickers(state: AppState, ruleConfig?: RuleConfigFile): string[] {
  return watchedTickersFrom(state, ruleConfig);
}

async function refreshLiveQuotes(
  box: StateBox,
  broker: IBroker,
  ruleConfig?: RuleConfigFile,
  quoteHub?: RealtimeQuoteHub | null,
  kisClient?: KisApi,
  quoteConsumerId = "bootstrap-owner",
): Promise<boolean> {
  const codes = watchedTickers(box.current, ruleConfig);
  if (codes.length === 0) {
    box.current = noteQuoteResult(box.current, true);
    return true;
  }

  // KIS PAPER: WebSocket cache only — no continuous REST inquirePrice.
  // Never acquire here — hub lifetime is owned by RuntimeScope.
  const hub = quoteHub ?? (kisClient ? peekPaperQuoteHub(kisClient) : null);
  if (hub && broker.driver === "kis") {
    try {
      await syncWatchedSubscriptions(hub, quoteConsumerId, codes);
    } catch (err) {
      const reason =
        err instanceof SubscriptionCapacityError
          ? err.message
          : err instanceof Error
            ? err.message
            : "WebSocket subscribe failed";
      box.current = noteQuoteResult(box.current, false);
      if (isLiveLike()) {
        box.current = markInquiryFailure(box.current, "data", reason);
      }
      return false;
    }
    const client = kisClient ?? getSharedKisClient();
    const result = await refreshQuotesFromWebSocket(box, hub, client, codes);
    box.current = noteQuoteResult(box.current, result.ok);
    if (!result.ok && isLiveLike()) {
      const detail = !result.connected
        ? "KIS WebSocket disconnected — 신규 주문을 막았습니다."
        : result.stale.length
          ? "KIS WebSocket 시세가 만료되어 신규 주문을 막았습니다."
          : "KIS WebSocket 시세가 없어 신규 주문을 막았습니다.";
      box.current = markInquiryFailure(box.current, "data", detail);
    }
    return result.ok;
  }

  // MOCK / tests without hub: legacy broker.getQuote path.
  let ok = true;
  for (const code of codes) {
    try {
      const quote = await broker.getQuote(code);
      if (!quote) ok = false;
      else if (isLiveLike() && box.current.quotes[code]?.source !== "kis") ok = false;
    } catch {
      ok = false;
    }
  }
  box.current = noteQuoteResult(box.current, ok);
  if (!ok && isLiveLike()) {
    box.current = markInquiryFailure(box.current, "data", "KIS 시세 조회에 실패해 신규 주문을 막았습니다.");
  }
  return ok;
}

export async function evaluateConditions(
  state: AppState,
  nowIso: string,
  brokerOpts: CreateBrokerOpts = {},
): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box, CASH_RULE_ID, brokerOpts);
  const now = new Date(nowIso).getTime();

  box.current = {
    ...box.current,
    conditions: box.current.conditions.map((cond) => {
      if (cond.status === "watching" && now > new Date(cond.expiresAt).getTime()) {
        return {
          ...cond,
          watching: false,
          status: "expired" as const,
          message: "조건기간이 만료되었습니다.",
        };
      }
      return cond;
    }),
  };

  for (const cond of box.current.conditions) {
    if (!cond.watching || cond.status !== "watching") continue;
    const quote = box.current.quotes[cond.code];
    if (!quote) continue;
    if (!conditionMatches(cond, quote)) continue;

    if (cond.orderPriceType === "limit" && cond.limitPrice) {
      if (!canFillLimit(cond.side, quote.price, cond.limitPrice)) continue;
    }

    const broker = root
      .forRule(cond.ruleId ?? CASH_RULE_ID)
      .withSource("condition", cond.id)
      .withIntent({
        intentId: makeSignalId(["sig", "cond", cond.id]),
        signalId: makeSignalId(["sig", "cond", cond.id]),
        reason: "condition",
      });
    const fill =
      cond.side === "sell"
        ? await broker.sellMarket(cond.code, cond.qty)
        : cond.orderPriceType === "limit" && cond.limitPrice
          ? await broker.buyLimit(cond.code, cond.limitPrice, cond.qty * cond.limitPrice)
          : await broker.buyMarket(cond.code, cond.qty * quote.price);

    if (!fill.ok && (fill.reason ?? "").includes("미체결")) continue;

    const updatedCond: AutoCondition =
      fill.status === "unknown"
        ? {
            ...cond,
            watching: false,
            status: "unknown",
            filledOrderId: fill.orderId,
            message: fill.reason ?? "주문 결과 미확인",
          }
        : fill.ok
          ? {
              ...cond,
              watching: false,
              status: "filled",
              filledAt: new Date().toISOString(),
              filledOrderId: fill.orderId,
              message: `${cond.side === "buy" ? "매수" : "매도"} ${fill.qty}주 체결`,
            }
          : fill.status === "pending"
            ? {
                ...cond,
                watching: false,
                status: "paused",
                filledOrderId: fill.orderId,
                message: fill.reason ?? "지정가 접수",
              }
            : {
                ...cond,
                watching: false,
                status: "rejected",
                message: fill.reason,
              };

    box.current = {
      ...box.current,
      conditions: box.current.conditions.map((c) => (c.id === cond.id ? updatedCond : c)),
    };
  }

  return box.current;
}

export async function evaluateDca(
  state: AppState,
  nowIso: string,
  brokerOpts: CreateBrokerOpts = {},
): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box, CASH_RULE_ID, brokerOpts);
  const now = new Date(nowIso).getTime();

  for (const plan of box.current.dcaPlans) {
    if (!plan.enabled) continue;
    if (new Date(plan.nextRunAt).getTime() > now) continue;
    const quote = box.current.quotes[plan.code];
    if (!quote) continue;

    const qty = Math.floor(plan.amountKrw / quote.price);
    const scheduled: DcaPlan = {
      ...plan,
      nextRunAt: new Date(now + plan.intervalSec * 1000).toISOString(),
      runCount: plan.runCount + 1,
    };

    if (qty < 1) {
      box.current = {
        ...box.current,
        dcaPlans: box.current.dcaPlans.map((p) =>
          p.id === plan.id
            ? { ...scheduled, lastMessage: "1주 미만이라 이번 회차는 건너뜁니다." }
            : p,
        ),
      };
      continue;
    }

    const fill = await root
      .forRule(plan.ruleId ?? CASH_RULE_ID)
      .withSource("dca", plan.id)
      .withIntent({
        intentId: makeSignalId(["sig", "dca", plan.id, scheduled.runCount]),
        signalId: makeSignalId(["sig", "dca", plan.id, scheduled.runCount]),
        reason: "dca",
      })
      .buyMarket(plan.code, plan.amountKrw);

    const updatedPlan: DcaPlan = {
      ...scheduled,
      lastMessage: fill.ok
        ? `${fill.qty}주 적립 매수`
        : fill.status === "pending"
          ? `${fill.qty}주 주문 접수 (체결 대기)`
          : fill.reason,
    };

    box.current = {
      ...box.current,
      dcaPlans: box.current.dcaPlans.map((p) => (p.id === plan.id ? updatedPlan : p)),
    };
  }

  return box.current;
}

export type TickRuntimeDeps = {
  /** Defaults to getSharedKisClient() for bootstrap compatibility. */
  kisClient?: KisApi;
  persistState?: (state: AppState) => Promise<void>;
  /** Account-scoped rules; defaults to global getRuleConfig(). */
  ruleConfig?: RuleConfigFile;
  /**
   * Observation balance sync. Default false uses HARD_LIMITS.balanceSyncMs.
   * Pre-trade paths still call refreshBrokerBalanceSnapshot forcefully.
   */
  forceBalanceSync?: boolean;
  /**
   * Account path: isScopeStartupSyncDone(id).
   * Omit → bootstrap processBootStartupVerified.
   */
  startupSyncVerified?: boolean;
  /** Account path: scope.lockPath. Omit → bootstrap holdsWorkerLock(). */
  workerLockPath?: string;
  /** PAPER WebSocket quote hub (process-local). */
  quoteHub?: RealtimeQuoteHub | null;
  /** Consumer id for shared-hub subscription ownership (brokerAccountId). */
  quoteConsumerId?: string;
};

export async function tickState(
  state: AppState,
  now = new Date(nowMs()),
  deps: TickRuntimeDeps = {},
): Promise<AppState> {
  if (state.safety && state.safety.kind === "store_corrupt") {
    return state;
  }
  if (state.lastEngineAt && now.getTime() - state.lastEngineAt < HARD_LIMITS.minTickMs) {
    return state;
  }

  const kisClient = deps.kisClient ?? getSharedKisClient();
  const forceBalance = deps.forceBalanceSync ?? false;
  // Prefer injected scope hub. Peek only — never acquire on tick (refCount leak / wrong ownership).
  const quoteHub = deps.quoteHub ?? peekPaperQuoteHub(kisClient);
  const quoteConsumerId = deps.quoteConsumerId ?? "bootstrap-owner";
  const safety = {
    startupSyncVerified: deps.startupSyncVerified,
    workerLockPath: deps.workerLockPath,
  };
  const brokerOpts: CreateBrokerOpts = {
    kisClient,
    persistState: deps.persistState,
    quoteHub,
    safety:
      deps.startupSyncVerified !== undefined || deps.workerLockPath
        ? safety
        : undefined,
  };
  const ruleConfig = deps.ruleConfig;

  const clock = getMarketClock(now);
  const prevSafety = safetyOf(state);
  const box: StateBox = {
    current: {
      ...ensureUniverseQuotes(state),
      tickCount: state.tickCount + 1,
      lastEngineAt: now.getTime(),
      updatedAt: clock.iso,
      settings: {
        ...state.settings,
        broker: "kis",
      },
      circuit: state.circuit ?? emptyCircuit(),
      safety: {
        ...prevSafety,
        lastTickAt: now.getTime(),
        blockedBuys: [],
        persistable: prevSafety.persistable,
      },
    },
  };
  // Drop persisted mock/seed before any order decision or display path.
  box.current = {
    ...box.current,
    quotes: invalidateNonKisQuotes(box.current.quotes),
  };

  let root: IBroker;
  let liveReady = true;
  try {
    root = createBroker(box, CASH_RULE_ID, brokerOpts);
  } catch (err) {
    const message =
      err instanceof BrokerNotReadyError
        ? err.message
        : err instanceof Error
          ? err.message
          : "KIS PAPER runtime not ready";
    box.current = markInquiryFailure(box.current, "broker", message);
    const equity = accountValue(box.current);
    return bumpTick(
      {
        ...box.current,
        equityHistory: [...(box.current.equityHistory ?? []), equity].slice(-120),
      },
      clock.open,
    );
  }

  expireStaleInFlight(box);
  const settled = await settleOpenOrders(box, kisClient);
  let recoveredOk = settled.ok;
  if (!settled.ok) {
    box.current = markInquiryFailure(
      box.current,
      "recon",
      settled.error ?? "당일 체결 조회에 실패했습니다.",
    );
    liveReady = false;
  } else {
    const recovered = await recoverExternalOrders(box, kisClient);
    recoveredOk = recovered.ok;
    if (!recovered.ok) {
      box.current = markInquiryFailure(box.current, "recon", recovered.error);
      liveReady = false;
    }
  }
  const synced = await syncKisBalance(box, kisClient, now.getTime(), {
    force: forceBalance,
  });
  if (!synced.ok) {
    box.current = markInquiryFailure(box.current, "broker", synced.error ?? "잔고 조회에 실패했습니다.");
    liveReady = false;
  }
  const quotesOk = await refreshLiveQuotes(
    box,
    root,
    ruleConfig,
    quoteHub,
    kisClient,
    quoteConsumerId,
  );
  if (!quotesOk && isLiveLike()) liveReady = false;
  box.current = noteInquiry(box.current, {
    quoteOk: quotesOk,
    balanceOk: synced.ok,
    orderableOk: Boolean(box.current.kisBalance?.orderableCash != null && box.current.kisBalance.orderableCash >= 0),
    positionOk: synced.ok,
    openOrdersOk: settled.ok && recoveredOk,
    executionOk: settled.ok,
    recon: reconStatusOf(box.current),
  });
  box.current = syncHttpAudit(box.current);
  if (liveReady && isLiveLike()) {
    box.current = clearSafetyBlock(resetRecoverableHalt(box.current), {
      quoteOk: true,
      brokerConnected: true,
      reconciliation: engineReconciliationFlag(box.current),
      workerHealthy: true,
    });
  }
  box.current = resumeTransientUnknownStop(box.current);
  const stop = box.current.controlledRun
    ? autoStopReason(box.current, process.env, brokerOpts.safety)
    : null;
  if (stop) {
    box.current = applyAutoStop(box.current, stop);
    liveReady = false;
  }

  const kisLiveSession = clock.open;
  const sessionOk = clock.open && kisLiveSession;
  box.current = RiskManager.rollDay(box.current, now);

  const tradingOn = autoRunAllowed(box.current);
  if (
    usesPaperStartupSync() &&
    startupSyncBlocksTrading(box.current, process.env, {
      bootVerified: deps.startupSyncVerified,
    })
  ) {
    liveReady = false;
  }
  if (sessionOk && tradingOn) {
    await new RiskManager(box).enforceStops({
      kisClient,
      persistState: deps.persistState,
      ruleConfig,
      safety: brokerOpts.safety,
      quoteHub,
    });
    box.current = RiskManager.checkDailyLoss(box.current);
  }

  const tradingAllowed =
    sessionOk &&
    tradingOn &&
    !tradingBlocked(box.current, brokerOpts.safety) &&
    liveReady;
  if (tradingAllowed) {
    box.current = await evaluateConditions(box.current, clock.iso, brokerOpts);
    box.current = await evaluateDca(box.current, clock.iso, brokerOpts);
    box.current = await QuantEngine.run(box.current, {
      kisClient,
      persistState: deps.persistState,
      ruleConfig,
      safety: brokerOpts.safety,
      quoteHub,
    });
  } else if (tradingOn && !clock.open) {
    const msg = `정규장 아님 (${clock.sessionLabel}) — 신규 주문 거부`;
    const already = box.current.allocations.some((row) => row.lastMessage?.includes("정규장 아님"));
    if (!already) guardLog("정규장 아님", clock.sessionLabel);
    box.current = {
      ...box.current,
      allocations: box.current.allocations.map((row) => ({
        ...row,
        lastMessage: msg,
      })),
    };
  } else if (tradingBlocked(box.current) || !tradingOn) {
    const locked = !box.current.settings.disclaimerAccepted
      ? "이용 동의 전에는 매매 실행이 잠겨 있습니다."
      : !box.current.settings.autoTrading
        ? "자동 실행이 꺼져 있습니다."
        : (tradingBlocked(box.current) ?? undefined);
    if (locked) {
      box.current = {
        ...box.current,
        allocations: box.current.allocations.map((row) => ({
          ...row,
          lastMessage: locked,
        })),
      };
    }
  }

  const equity = accountValue(box.current);
  const withTick = bumpTick(
    {
      ...box.current,
      equityHistory: [...(box.current.equityHistory ?? []), equity].slice(-120),
    },
    clock.open,
  );
  return withTick;
}

export { accountValue, accountValue as portfolioValue };
