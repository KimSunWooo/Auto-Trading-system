import { clampDailyLimit, roundToTick, tickSize } from "./tick-size";
import type { AppState, AutoCondition, DcaPlan, Quote } from "./types";
import { findStock } from "./universe";
import { getMarketClock } from "./market-hours";
import { canFillLimit } from "@/src/accounts/fills";
import { cashFromAllocations, DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { accountValue } from "@/src/accounts/portfolio";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker, brokerDriver } from "@/src/brokers/index";
import type { IBroker } from "@/src/brokers/IBroker";
import { QuantEngine } from "@/src/engine/QuantEngine";
import { emptyCircuit, tradingBlocked } from "@/src/risk/circuit";
import { HARD_LIMITS, seoulDay } from "@/src/risk/limits";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import { RiskManager } from "@/src/risk/RiskManager";
import { expireStaleInFlight, settleOpenOrders } from "@/src/risk/reconcile";
import { syncKisBalance } from "@/src/risk/balance-sync";
import { getSharedKisClient } from "@/src/brokers/kis-client";
import { watchedTickersFrom } from "@/src/rules/config";
import { autoRunAllowed } from "@/src/rules/disclaimer";
import { CASH_RULE_ID } from "@/src/rules/params";
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

const HISTORY_LEN = 40;

export { applyFill, canFillLimit, feeBreakdown, findPosition } from "@/src/accounts/fills";

export function seedQuote(code: string, prevClose = 10_000, name?: string): Quote {
  const stock = findStock(code);
  const price = roundToTick(stock?.prevClose ?? prevClose);
  const tick = tickSize(price);
  return {
    code,
    name: name ?? stock?.name ?? code,
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
    source: "seed",
  };
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
      ignoreMarketHours: true,
      startingCash: TOTAL_DEPOSIT,
      broker: brokerDriver(),
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

/** Paper book with consent already recorded — unit tests only. */
export function createPaperState(): AppState {
  const state = createInitialState();
  state.settings.disclaimerAccepted = true;
  state.settings.autoTrading = true;
  state.quotes = {
    "005930": seedQuote("005930", 74_800),
    "035720": seedQuote("035720", 42_150),
    "247540": seedQuote("247540", 142_700),
  };
  return state;
}

export function ensureUniverseQuotes(state: AppState): AppState {
  if (isLiveLike() && brokerDriver() === "kis") {
    return state;
  }
  const quotes = { ...state.quotes };
  for (const code of watchedTickersFrom(state)) {
    if (!quotes[code]) quotes[code] = seedQuote(code);
  }
  return { ...state, quotes };
}

export function advanceQuotes(
  quotes: Record<string, Quote>,
  rng: () => number = Math.random,
): Record<string, Quote> {
  const next: Record<string, Quote> = {};
  for (const [code, q] of Object.entries(quotes)) {
    const vol = 0.0012 + rng() * 0.004;
    const shock = (rng() - 0.5) * 2 * vol;
    const raw = q.price * (1 + shock);
    const price = clampDailyLimit(raw, q.prevClose);
    const tick = tickSize(price);
    const bid = roundToTick(Math.max(tick, price - tick));
    const ask = roundToTick(price + tick);
    const history = [...q.history, price].slice(-HISTORY_LEN);
    next[code] = {
      ...q,
      price,
      high: Math.max(q.high, price),
      low: Math.min(q.low, price),
      volume: q.volume + Math.floor(400 + rng() * 2200),
      bid,
      ask,
      history,
      source: "mock",
    };
  }
  return next;
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

function watchedTickers(state: AppState): string[] {
  return watchedTickersFrom(state);
}

async function refreshLiveQuotes(box: StateBox, broker: IBroker): Promise<boolean> {
  let ok = true;
  const codes = watchedTickers(box.current);
  if (codes.length === 0) {
    box.current = noteQuoteResult(box.current, true);
    return true;
  }
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

export async function evaluateConditions(state: AppState, nowIso: string): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box);
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

export async function evaluateDca(state: AppState, nowIso: string): Promise<AppState> {
  const box: StateBox = { current: state };
  const root = createBroker(box);
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

export async function tickState(state: AppState, now = new Date(nowMs())): Promise<AppState> {
  if (state.safety && state.safety.kind === "store_corrupt") {
    return state;
  }
  if (state.lastEngineAt && now.getTime() - state.lastEngineAt < HARD_LIMITS.minTickMs) {
    return state;
  }

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
        broker: brokerDriver(),
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
  const root = createBroker(box);
  let liveReady = true;

  if (root.driver === "kis") {
    expireStaleInFlight(box);
    const settled = await settleOpenOrders(box, getSharedKisClient());
    let recoveredOk = settled.ok;
    if (!settled.ok) {
      box.current = markInquiryFailure(
        box.current,
        "recon",
        settled.error ?? "당일 체결 조회에 실패했습니다.",
      );
      liveReady = false;
    } else {
      const recovered = await recoverExternalOrders(box, getSharedKisClient());
      recoveredOk = recovered.ok;
      if (!recovered.ok) {
        box.current = markInquiryFailure(box.current, "recon", recovered.error);
        liveReady = false;
      }
    }
    const synced = await syncKisBalance(box, getSharedKisClient(), now.getTime(), { force: isLiveLike() });
    if (!synced.ok) {
      box.current = markInquiryFailure(box.current, "broker", synced.error ?? "잔고 조회에 실패했습니다.");
      liveReady = false;
    }
    const quotesOk = await refreshLiveQuotes(box, root);
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
    const stop = box.current.controlledRun ? autoStopReason(box.current) : null;
    if (stop) {
      box.current = applyAutoStop(box.current, stop);
      liveReady = false;
    }
  } else {
    if (box.current.settings.ignoreMarketHours || clock.open) {
      box.current = { ...box.current, quotes: advanceQuotes(box.current.quotes) };
    }
  }

  const kisLiveSession = root.driver !== "kis" || clock.open;
  const sessionOk = clock.open && kisLiveSession;
  box.current = RiskManager.rollDay(box.current, now);

  const tradingOn = autoRunAllowed(box.current);
  if (sessionOk && tradingOn) {
    await new RiskManager(box).enforceStops();
    box.current = RiskManager.checkDailyLoss(box.current);
  }

  const tradingAllowed =
    sessionOk &&
    tradingOn &&
    !tradingBlocked(box.current) &&
    (root.driver !== "kis" || liveReady);
  if (tradingAllowed) {
    box.current = await evaluateConditions(box.current, clock.iso);
    box.current = await evaluateDca(box.current, clock.iso);
    box.current = await QuantEngine.run(box.current);
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
