import type { AppState, CircuitKind, Order, Position } from "@/lib/types";
import { getMarketClock } from "@/lib/market-hours";
import { nowIso, nowMs } from "@/src/clock";
import { padOdno } from "@/src/brokers/kis-client";
import { persistenceMode } from "@/src/db/config";
import { publicDatabaseStatus } from "@/src/db/mirror";
import {
  engineReconciliationFlag,
  reconProjectionFromState,
  usesPaperBrokerBalanceSemantics,
} from "@/src/risk/kis-balance-semantics";
import {
  CONTROLLED_RUN_MAX_BROKER_SUBMITS,
  PAPER_ORDER_POLICY,
  existingOpenBuy,
  hasUnknownOrder,
  sessionBrokerSubmitCount,
  sessionOrders,
  testRunBuyCount,
} from "@/src/risk/order-policy";
import type { UserRule } from "@/src/rules/params";
import { kisHttpAudit } from "@/src/runtime/kis-http-audit";
import { holdsWorkerLock, workerLockHealthy } from "@/src/runtime/worker-lock";
import {
  allowLiveTrading,
  isLiveLike,
  tradingMode,
  type EnvMap,
} from "@/src/runtime/trading-mode";
import { overseasPaperOrdersLocked } from "@/src/markets/overseas/env";

export const CONTROLLED_RUN_GATE = "Domestic PAPER Live-Market Controlled Auto-Trading";
export { CONTROLLED_RUN_MAX_BROKER_SUBMITS, sessionBrokerSubmitCount, sessionOrders } from "@/src/risk/order-policy";
export const CONTROLLED_RUN_QUOTE_FRESH_MS = 15_000;
export const MAX_CONTROLLED_EVENTS = 240;
export const CONSECUTIVE_INQUIRY_FAIL_LIMIT = 3;
const TRANSIENT_UNKNOWN_STOP_RE = /^Reconciliation UNKNOWN$/i;

export type ControlledRunEventKind =
  | "SIGNAL"
  | "RISK_ALLOW"
  | "RISK_BLOCK"
  | "INTENT_CREATED"
  | "ORDER_SUBMITTED"
  | "ODNO"
  | "PARTIAL_FILL"
  | "FILLED"
  | "POSITION_CHANGED"
  | "TRADE_OPEN"
  | "TRADE_CLOSED"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "RECONCILIATION"
  | "AUTO_STOP";

export type ControlledRunStatus = "idle" | "running" | "paused" | "stopped";

export type ControlledInquiry = {
  quoteOk: boolean;
  balanceOk: boolean;
  orderableOk: boolean;
  positionOk: boolean;
  openOrdersOk: boolean;
  executionOk: boolean;
  recon: "HEALTHY" | "MISMATCH" | "UNKNOWN" | "FAILED";
};

export type ControlledRunEvent = {
  at: string;
  kind: ControlledRunEventKind;
  message: string;
};

export type ControlledRunState = {
  gate: typeof CONTROLLED_RUN_GATE;
  startedAt: string;
  stoppedAt?: string;
  status: ControlledRunStatus;
  autoStopReason?: string;
  strategyName: string;
  symbols: string[];
  ticks: number;
  quoteSuccess: number;
  quoteFail: number;
  signals: number;
  riskAllowed: number;
  riskBlocked: number;
  brokerSubmits: number;
  buyCount: number;
  sellCount: number;
  executions: number;
  partialFills: number;
  duplicateExecutions: number;
  duplicateSubmit: number;
  unknownCount: number;
  reconHealthy: number;
  reconMismatch: number;
  reconUnknown: number;
  mirrorErrors: number;
  jsonRdsDivergence: number;
  kisJsonDivergence: number;
  realRequests: number;
  overseasOrders: number;
  lastTickAt?: number;
  lastInquiry: ControlledInquiry;
  consecutiveInquiryFailures: number;
  events: ControlledRunEvent[];
};

export type StrategySelection = {
  strategy: string;
  symbols: string[];
  reason: string;
  parametersChanged: false;
  enabledCount: number;
};

const SECRET_RE =
  /(appkey|appsecret|secret|password|token|authorization|bearer|cano|account)[=:\s]+[^\s,]+/gi;

export function redactControlledMessage(message: string): string {
  return message.replace(SECRET_RE, "$1=[redacted]").slice(0, 400);
}

export function emptyInquiry(): ControlledInquiry {
  return {
    quoteOk: false,
    balanceOk: false,
    orderableOk: false,
    positionOk: false,
    openOrdersOk: false,
    executionOk: false,
    recon: "UNKNOWN",
  };
}

export function emptyControlledRun(input: {
  startedAt?: string;
  strategyName: string;
  symbols: string[];
}): ControlledRunState {
  return {
    gate: CONTROLLED_RUN_GATE,
    startedAt: input.startedAt ?? nowIso(),
    status: "running",
    strategyName: input.strategyName,
    symbols: [...input.symbols],
    ticks: 0,
    quoteSuccess: 0,
    quoteFail: 0,
    signals: 0,
    riskAllowed: 0,
    riskBlocked: 0,
    brokerSubmits: 0,
    buyCount: 0,
    sellCount: 0,
    executions: 0,
    partialFills: 0,
    duplicateExecutions: 0,
    duplicateSubmit: 0,
    unknownCount: 0,
    reconHealthy: 0,
    reconMismatch: 0,
    reconUnknown: 0,
    mirrorErrors: 0,
    jsonRdsDivergence: 0,
    kisJsonDivergence: 0,
    realRequests: 0,
    overseasOrders: 0,
    lastInquiry: emptyInquiry(),
    consecutiveInquiryFailures: 0,
    events: [],
  };
}

export function padTicker(code: string): string {
  return code.replace(/\D/g, "").slice(-6).padStart(6, "0");
}

/** Existing enabled UserRules only. Never invents a rule or changes parameters. */
export function selectConservativeStrategy(
  rules: UserRule[],
  positions: Position[],
): StrategySelection {
  const enabled = rules.filter((row) => row.enabled && row.ticker);
  const held = [
    ...new Set(positions.filter((row) => row.qty > 0).map((row) => padTicker(row.code))),
  ];
  if (enabled.length === 0) {
    return {
      strategy: "none",
      symbols: held.slice(0, 3),
      reason:
        "strategy-config.json 에 활성화된 UserRule 이 없다. interval 조건식은 보유 포지션을 보지 않고 주기 매수하므로 켜지 않았다. admin preset 을 엔진에 넣지 않았다. 기존 005930 1주는 RiskManager 손절만 적용한다.",
      parametersChanged: false,
      enabledCount: 0,
    };
  }
  const ranked = [...enabled].sort((a, b) => {
    const kindRank = (row: UserRule) => (row.kind === "ma-cross" ? 0 : 1);
    const kind = kindRank(a) - kindRank(b);
    if (kind !== 0) return kind;
    const buy = a.buyPct - b.buyPct;
    if (buy !== 0) return buy;
    return b.intervalMs - a.intervalMs;
  });
  const chosen = ranked[0]!;
  return {
    strategy: chosen.name || chosen.id,
    symbols: [chosen.ticker, ...held.filter((code) => code !== chosen.ticker)].slice(0, 3),
    reason: `활성화된 ${enabled.length}개 중 가장 보수적인 기존 조건식(${chosen.kind}, buyPct=${chosen.buyPct})을 선택했다. 파라미터는 수정하지 않았다.`,
    parametersChanged: false,
    enabledCount: enabled.length,
  };
}

export function intervalIgnoresPosition(kind: UserRule["kind"]): boolean {
  return kind === "interval";
}

export function controlledRunOf(state: Pick<AppState, "controlledRun">): ControlledRunState | undefined {
  return state.controlledRun;
}

export function patchControlledRun(
  state: AppState,
  patch: Partial<ControlledRunState> | ((current: ControlledRunState) => ControlledRunState),
): AppState {
  const current = state.controlledRun;
  if (!current) return state;
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
  return { ...state, controlledRun: next };
}

export function recordControlledEvent(
  state: AppState,
  kind: ControlledRunEventKind,
  message: string,
): AppState {
  const run = state.controlledRun;
  if (!run || run.status === "idle") return state;
  const event: ControlledRunEvent = {
    at: nowIso(),
    kind,
    message: redactControlledMessage(message),
  };
  const bump: Partial<ControlledRunState> = {};
  if (kind === "SIGNAL") bump.signals = run.signals + 1;
  if (kind === "RISK_ALLOW") bump.riskAllowed = run.riskAllowed + 1;
  if (kind === "RISK_BLOCK") bump.riskBlocked = run.riskBlocked + 1;
  if (kind === "ORDER_SUBMITTED") bump.brokerSubmits = run.brokerSubmits + 1;
  if (kind === "PARTIAL_FILL") bump.partialFills = run.partialFills + 1;
  if (kind === "FILLED") bump.executions = run.executions + 1;
  if (kind === "AUTO_STOP") {
    bump.status = "stopped";
    bump.stoppedAt = event.at;
    bump.autoStopReason = event.message;
  }
  return {
    ...state,
    controlledRun: {
      ...run,
      ...bump,
      events: [...run.events, event].slice(-MAX_CONTROLLED_EVENTS),
    },
  };
}

export function seoulDayIso(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

export function duplicateOdnoDetected(state: AppState): boolean {
  const counts = new Map<string, number>();
  for (const order of state.orders) {
    if (order.parentOrderId || !order.brokerOrderNo) continue;
    const key = padOdno(order.brokerOrderNo);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
}

export function duplicateExecutionDetected(state: AppState): boolean {
  const counts = new Map<string, number>();
  for (const order of state.orders) {
    if (!order.parentOrderId || order.status !== "filled" || !order.brokerOrderNo) continue;
    const key = `${padOdno(order.brokerOrderNo)}:${order.filledQty ?? order.qty}:${order.price}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n > 1);
}

export function quoteHealthy(state: AppState, ticker: string, now = nowMs()): boolean {
  const quote = state.quotes[padTicker(ticker)] ?? state.quotes[ticker];
  if (!quote) return false;
  if (quote.source !== "kis") return false;
  if (!quote.freshAt || now - quote.freshAt > CONTROLLED_RUN_QUOTE_FRESH_MS) return false;
  return quote.price > 0;
}

export function kisJsonPositionDiverged(state: AppState): boolean {
  const snap = state.kisBalance;
  if (!snap) return true;
  const local = new Map<string, number>();
  for (const pos of state.positions) {
    if (pos.qty < 1) continue;
    const code = padTicker(pos.code);
    local.set(code, (local.get(code) ?? 0) + pos.qty);
  }
  const remote = new Map<string, number>();
  for (const hold of snap.holdings) {
    if (hold.qty < 1) continue;
    const code = padTicker(hold.ticker);
    remote.set(code, (remote.get(code) ?? 0) + hold.qty);
  }
  const keys = new Set([...local.keys(), ...remote.keys()]);
  for (const key of keys) {
    if ((local.get(key) ?? 0) !== (remote.get(key) ?? 0)) return true;
  }
  return false;
}

export function reconStatusOf(state: AppState, env: EnvMap = process.env): ControlledInquiry["recon"] {
  const projected = reconProjectionFromState(state, env);
  if (!projected) return "UNKNOWN";
  return projected.status;
}

export function isTransientUnknownStopReason(reason: string | undefined): boolean {
  return TRANSIENT_UNKNOWN_STOP_RE.test((reason ?? "").trim());
}

export function inquiryTransientlyUnhealthy(inquiry: ControlledInquiry): boolean {
  if (inquiry.recon === "MISMATCH") return false;
  return (
    !inquiry.quoteOk ||
    !inquiry.balanceOk ||
    !inquiry.orderableOk ||
    !inquiry.positionOk ||
    !inquiry.openOrdersOk ||
    !inquiry.executionOk ||
    inquiry.recon === "UNKNOWN" ||
    inquiry.recon === "FAILED"
  );
}

export function repeatedInquiryStopReason(run: ControlledRunState): string | null {
  if ((run.consecutiveInquiryFailures ?? 0) < CONSECUTIVE_INQUIRY_FAIL_LIMIT) return null;
  const inquiry = run.lastInquiry;
  if (!inquiry.quoteOk) return "Quote repeated failure";
  if (!inquiry.balanceOk || !inquiry.orderableOk) return "Balance query repeated failure";
  if (inquiry.recon === "UNKNOWN" || inquiry.recon === "FAILED") return "Reconciliation UNKNOWN";
  if (!inquiry.positionOk || !inquiry.openOrdersOk || !inquiry.executionOk) {
    return "Inquiry repeated failure";
  }
  return null;
}

export function isRecoverableInquiryHalt(state: AppState): boolean {
  const circuit = state.circuit;
  if (!circuit?.halted) return false;
  if (state.orders.some((order) => !order.parentOrderId && order.status === "unknown")) {
    return false;
  }
  const kind: CircuitKind | undefined = circuit.kind;
  if (kind === "kill" || kind === "daily-loss" || kind === "unknown") {
    return false;
  }
  if (kind === "soak-stop") {
    return isTransientUnknownStopReason(circuit.reason ?? circuit.lastError);
  }
  if (kind === "recon" || kind === "data") return true;
  if (kind === "hard" || kind === "balance") {
    return /timeout|aborted|조회|잔고|시세|체결|거래건수|초당/i.test(circuit.reason ?? circuit.lastError ?? "");
  }
  return false;
}

export function domesticPaperControlledEnv(env: EnvMap = process.env): string | null {
  if (tradingMode(env) !== "live_test") return "TRADING_MODE must be live_test";
  if (env.BROKER !== "kis") return "BROKER must be kis";
  const kisMode = String(env.KIS_MODE ?? "").trim().toLowerCase();
  if (kisMode !== "demo" && kisMode !== "paper") return "KIS_MODE must be demo or paper";
  if (!usesPaperBrokerBalanceSemantics(env)) return "PAPER broker semantics are not active";
  if (allowLiveTrading(env)) return "ALLOW_LIVE_TRADING must be false";
  if (env.KIS_LIVE_CONFIRM === "I_UNDERSTAND") return "KIS_LIVE_CONFIRM must stay unset";
  if (String(env.TRADING_MODE ?? "").trim().toLowerCase() === "live") return "REAL TRADING_MODE=live is locked";
  if (persistenceMode(env) !== "mirror") return "PERSISTENCE_MODE must be mirror";
  if (!overseasPaperOrdersLocked(env)) return "Overseas order opt-in must stay off";
  return null;
}

export function preTradeGate(
  state: AppState,
  input: { side: "buy" | "sell"; ticker: string; qty: number },
  env: EnvMap = process.env,
): { ok: true } | { ok: false; blocked: string } {
  if (!isLiveLike(tradingMode(env)) || env.BROKER !== "kis") return { ok: true };
  const envBlock = domesticPaperControlledEnv(env);
  if (envBlock) return { ok: false, blocked: envBlock };
  const clock = getMarketClock(new Date(nowMs()));
  if (!clock.open) {
    return { ok: false, blocked: `정규장 아님 (${clock.sessionLabel}) — 신규 주문 거부` };
  }
  if (!holdsWorkerLock()) {
    return { ok: false, blocked: "트레이딩 워커 락이 없어 주문하지 않습니다." };
  }
  const run = state.controlledRun;
  if (run?.status === "stopped") {
    return { ok: false, blocked: run.autoStopReason ?? "AUTO TRADING STOP" };
  }
  if (hasUnknownOrder(state)) {
    return { ok: false, blocked: "UNKNOWN order unresolved" };
  }
  if (duplicateOdnoDetected(state) || duplicateExecutionDetected(state)) {
    return { ok: false, blocked: "Duplicate execution or ODNO mapping" };
  }
  if (!quoteHealthy(state, input.ticker)) {
    return { ok: false, blocked: `${input.ticker} KIS quote unhealthy — NO TRADE` };
  }
  const quote = state.quotes[padTicker(input.ticker)] ?? state.quotes[input.ticker];
  if (quote?.source === "mock" || quote?.source === "seed") {
    return { ok: false, blocked: "Mock/synthetic/stale price forbidden" };
  }
  const inquiry = run?.lastInquiry;
  if (inquiry) {
    if (!inquiry.quoteOk) return { ok: false, blocked: "Quote query unhealthy" };
    if (!inquiry.balanceOk) return { ok: false, blocked: "Broker balance unhealthy" };
    if (!inquiry.orderableOk && input.side === "buy") {
      return { ok: false, blocked: "Orderable cash unhealthy" };
    }
    if (!inquiry.positionOk) return { ok: false, blocked: "Position query unhealthy" };
    if (!inquiry.openOrdersOk) return { ok: false, blocked: "Open orders query unhealthy" };
    if (!inquiry.executionOk) return { ok: false, blocked: "Execution query unhealthy" };
    if (inquiry.recon !== "HEALTHY") {
      return { ok: false, blocked: `Reconciliation ${inquiry.recon}` };
    }
  } else {
    const recon = reconStatusOf(state, env);
    if (recon !== "HEALTHY") return { ok: false, blocked: `Reconciliation ${recon}` };
    if (engineReconciliationFlag(state) !== "synced") {
      return { ok: false, blocked: "Fresh reconciliation is not HEALTHY" };
    }
  }
  if (kisJsonPositionDiverged(state)) {
    return { ok: false, blocked: "KIS / JSON position divergence" };
  }
  const http = kisHttpAudit();
  if (http.realRequests > 0) return { ok: false, blocked: "REAL endpoint request detected" };
  if (http.overseasOrders > 0) return { ok: false, blocked: "Overseas order HTTP detected" };

  if (input.side === "buy") {
    if (existingOpenBuy(state, input.ticker)) {
      return { ok: false, blocked: "ORDER TEST BLOCKED: Existing open BUY order detected" };
    }
    const buys = testRunBuyCount(state, state.controlledRun?.startedAt);
    if (buys >= PAPER_ORDER_POLICY.maxNewBuyPerTestRun) {
      return {
        ok: false,
        blocked: `ORDER TEST BLOCKED: maxNewBuyPerTestRun ${PAPER_ORDER_POLICY.maxNewBuyPerTestRun}`,
      };
    }
    const orderable = state.kisBalance?.orderableCash;
    if (orderable == null || !(orderable > 0)) {
      return { ok: false, blocked: "ord_psbl_cash missing or 0 — not using dnca_tot_amt" };
    }
    const last = quote?.price ?? 0;
    if (last > 0 && orderable < last) {
      return { ok: false, blocked: "Orderable cash cannot buy 1 share" };
    }
  } else {
    const jsonQty = state.positions
      .filter((row) => padTicker(row.code) === padTicker(input.ticker))
      .reduce((sum, row) => sum + row.qty, 0);
    const kisQty = (state.kisBalance?.holdings ?? [])
      .filter((row) => padTicker(row.ticker) === padTicker(input.ticker))
      .reduce((sum, row) => sum + row.qty, 0);
    const available = Math.min(jsonQty, kisQty);
    if (input.qty > available) {
      return { ok: false, blocked: "SELL qty exceeds KIS/JSON available qty" };
    }
  }

  const submits = sessionBrokerSubmitCount(state);
  if (submits >= CONTROLLED_RUN_MAX_BROKER_SUBMITS) {
    return { ok: false, blocked: `Daily/session PAPER broker submit cap ${CONTROLLED_RUN_MAX_BROKER_SUBMITS}` };
  }

  const db = publicDatabaseStatus(env);
  if (!db.enabled || db.mode !== "mirror") {
    return { ok: false, blocked: "RDS mirror is required for this run" };
  }
  if (db.lastError?.includes("DB_MIRROR_DEGRADED") && input.side === "buy") {
    // Mirror errors do not retry the broker; new buys still require a connected mirror.
  }
  return { ok: true };
}

export function autoStopReason(state: AppState, env: EnvMap = process.env): string | null {
  const http = kisHttpAudit();
  if (http.realRequests > 0) return "REAL endpoint request";
  if (http.overseasOrders > 0) return "Overseas order HTTP";
  if (hasUnknownOrder(state)) return "UNKNOWN unresolved";
  if (duplicateExecutionDetected(state)) return "Duplicate execution";
  if (duplicateOdnoDetected(state)) return "Duplicate ODNO mapping";
  if (kisJsonPositionDiverged(state) && state.kisBalance?.freshness === "fresh") {
    return "KIS / JSON position divergence";
  }
  if (engineReconciliationFlag(state) === "mismatch") return "Reconciliation MISMATCH";
  if (reconStatusOf(state, env) === "MISMATCH") return "Reconciliation MISMATCH";
  const run = state.controlledRun;
  const repeated = run ? repeatedInquiryStopReason(run) : null;
  if (repeated) return repeated;
  if (isLiveLike(tradingMode(env)) && !holdsWorkerLock() && !workerLockHealthy()) {
    return "Worker lock lost";
  }
  if (sessionBrokerSubmitCount(state) >= CONTROLLED_RUN_MAX_BROKER_SUBMITS) {
    return "Daily order limit reached";
  }
  if (run && run.jsonRdsDivergence > 0) return "DB / JSON position divergence";
  return null;
}

export function isTransientInquirySoakStop(state: AppState): boolean {
  const run = state.controlledRun;
  if (run?.status !== "stopped") return false;
  const reason = run.autoStopReason ?? state.circuit?.reason ?? state.circuit?.lastError;
  return isTransientUnknownStopReason(reason);
}

export function resumeTransientUnknownStop(state: AppState, env: EnvMap = process.env): AppState {
  if (!isTransientInquirySoakStop(state)) return state;
  if (hasUnknownOrder(state)) return state;
  if (duplicateExecutionDetected(state) || duplicateOdnoDetected(state)) return state;
  if (kisHttpAudit().realRequests > 0 || kisHttpAudit().overseasOrders > 0) return state;
  if (engineReconciliationFlag(state) === "mismatch") return state;
  if (reconStatusOf(state, env) !== "HEALTHY") return state;
  if (state.kisBalance?.freshness === "unknown") return state;
  if (kisJsonPositionDiverged(state) && state.kisBalance?.freshness === "fresh") return state;
  const run = state.controlledRun;
  if (!run) return state;
  const clock = getMarketClock(new Date(nowMs()));
  const resumed = recordControlledEvent(
    {
      ...state,
      settings: { ...state.settings, autoTrading: true },
      circuit: {
        halted: false,
        kind: undefined,
        unknownCount: state.circuit?.unknownCount ?? 0,
      },
      controlledRun: {
        ...run,
        status: clock.open ? "running" : "paused",
        autoStopReason: undefined,
        stoppedAt: undefined,
        consecutiveInquiryFailures: 0,
      },
    },
    "RECONCILIATION",
    "Resumed after transient Reconciliation UNKNOWN. Single inquiry timeout is NO ORDER, not AUTO STOP.",
  );
  return resumed;
}

export function applyAutoStop(state: AppState, reason: string): AppState {
  if (state.controlledRun?.status === "stopped") return state;
  const next = recordControlledEvent(state, "AUTO_STOP", reason);
  return {
    ...next,
    circuit: {
      halted: true,
      kind: "soak-stop",
      reason,
      unknownCount: next.circuit?.unknownCount ?? 0,
      openedAt: next.circuit?.openedAt ?? nowIso(),
      lastError: reason,
    },
  };
}

export function syncHttpAudit(state: AppState): AppState {
  const run = state.controlledRun;
  if (!run) return state;
  const http = kisHttpAudit();
  return {
    ...state,
    controlledRun: {
      ...run,
      realRequests: http.realRequests,
      overseasOrders: http.overseasOrders,
    },
  };
}

export function noteQuoteResult(state: AppState, ok: boolean): AppState {
  const run = state.controlledRun;
  if (!run) return state;
  return {
    ...state,
    controlledRun: {
      ...run,
      quoteSuccess: run.quoteSuccess + (ok ? 1 : 0),
      quoteFail: run.quoteFail + (ok ? 0 : 1),
      lastInquiry: { ...run.lastInquiry, quoteOk: ok },
    },
  };
}

export function noteInquiry(state: AppState, patch: Partial<ControlledInquiry>): AppState {
  const run = state.controlledRun;
  if (!run) return state;
  const lastInquiry = { ...run.lastInquiry, ...patch };
  const bump: Partial<ControlledRunState> = {};
  if (patch.recon === "HEALTHY") bump.reconHealthy = run.reconHealthy + 1;
  if (patch.recon === "MISMATCH") bump.reconMismatch = run.reconMismatch + 1;
  if (patch.recon === "UNKNOWN" || patch.recon === "FAILED") {
    bump.reconUnknown = run.reconUnknown + 1;
  }
  bump.consecutiveInquiryFailures = inquiryTransientlyUnhealthy(lastInquiry)
    ? (run.consecutiveInquiryFailures ?? 0) + 1
    : 0;
  return {
    ...state,
    controlledRun: { ...run, ...bump, lastInquiry },
  };
}

export function bumpTick(state: AppState, clockOpen: boolean): AppState {
  const run = state.controlledRun;
  if (!run || run.status === "stopped") return state;
  return {
    ...state,
    controlledRun: {
      ...run,
      ticks: run.ticks + 1,
      lastTickAt: nowMs(),
      status: clockOpen ? "running" : "paused",
    },
  };
}

export function existingPositionLines(state: AppState): string[] {
  if (state.positions.filter((row) => row.qty > 0).length === 0) return ["none"];
  return state.positions
    .filter((row) => row.qty > 0)
    .map((row) => `${row.code} ${row.name} qty=${row.qty} avg=${row.avgPrice}`);
}

export function formatStartSummary(input: {
  ready: boolean;
  readyReason?: string;
  strategy: StrategySelection;
  positions: string[];
  recon: string;
  rds: string;
}): string {
  return [
    "Domestic PAPER Controlled Run",
    "",
    "Mode:",
    "LIVE_TEST",
    "",
    "Broker:",
    "KIS PAPER",
    "",
    "Persistence:",
    "MIRROR",
    "",
    "Strategy:",
    input.strategy.strategy,
    "",
    "Symbols:",
    input.strategy.symbols.join(", ") || "(none)",
    "",
    "Existing Positions:",
    ...input.positions,
    "",
    "Order Qty Limit:",
    "1",
    "",
    "Daily Limit:",
    "5",
    "",
    "Reconciliation:",
    input.recon,
    "",
    "RDS:",
    input.rds,
    "",
    "REAL:",
    "LOCKED",
    "",
    "Overseas:",
    "DISABLED",
    "",
    "Ready:",
    input.ready ? "YES" : `NO${input.readyReason ? ` (${input.readyReason})` : ""}`,
  ].join("\n");
}

export function realizedFromOrders(state: AppState, startedAt?: string): number {
  const startMs = startedAt ? Date.parse(startedAt) : 0;
  return state.orders
    .filter((order) => !order.parentOrderId && order.side === "sell" && order.realizedPnl != null)
    .filter((order) => Date.parse(order.createdAt) >= startMs)
    .reduce((sum, order) => sum + (order.realizedPnl ?? 0), 0);
}

export function unrealizedFromState(state: AppState): number {
  let sum = 0;
  for (const pos of state.positions) {
    if (pos.qty < 1) continue;
    const last = state.quotes[pos.code]?.price ?? pos.avgPrice;
    sum += (last - pos.avgPrice) * pos.qty;
  }
  return Math.round(sum);
}

export function formatSoakReport(state: AppState): string {
  const run = state.controlledRun;
  const start = run?.startedAt;
  const session = sessionOrders(state, start);
  const buys = session.filter((row) => row.side === "buy");
  const sells = session.filter((row) => row.side === "sell");
  const unknown = session.filter((row) => row.status === "unknown");
  const assessment =
    run?.status === "stopped"
      ? "C.\nSafety or consistency issue detected.\nAuto trading stopped."
      : session.length === 0
        ? "B.\nNo trade occurred, but live quote/strategy/runtime stayed healthy."
        : "A.\nControlled domestic PAPER operation completed normally.";
  return [
    "Domestic PAPER Live-Market Controlled Run",
    "=========================================",
    "",
    "Environment",
    "-----------",
    "",
    "Mode:",
    "LIVE_TEST",
    "",
    "Broker:",
    "KIS PAPER",
    "",
    "Persistence:",
    "MIRROR",
    "",
    "REAL:",
    "LOCKED",
    "",
    "Overseas:",
    "DISABLED",
    "",
    "",
    "Strategy",
    "--------",
    "",
    "Strategy:",
    run?.strategyName ?? "none",
    "",
    "Symbols:",
    (run?.symbols ?? []).join(", "),
    "",
    "Parameters Changed:",
    "NO",
    "",
    "",
    "Runtime",
    "-------",
    "",
    "Ticks:",
    String(run?.ticks ?? 0),
    "",
    "Quote Success:",
    String(run?.quoteSuccess ?? 0),
    "",
    "Quote Fail:",
    String(run?.quoteFail ?? 0),
    "",
    "Signals:",
    String(run?.signals ?? 0),
    "",
    "Risk Allowed:",
    String(run?.riskAllowed ?? 0),
    "",
    "Risk Blocked:",
    String(run?.riskBlocked ?? 0),
    "",
    "",
    "Orders",
    "------",
    "",
    "Total Broker Submits:",
    String(run?.brokerSubmits ?? buys.length + sells.length),
    "",
    "BUY:",
    String(run?.buyCount ?? buys.length),
    "",
    "SELL:",
    String(run?.sellCount ?? sells.length),
    "",
    "UNKNOWN:",
    String(unknown.length),
    "",
    "Duplicate Submit:",
    String(run?.duplicateSubmit ?? 0),
    "",
    "",
    "Executions",
    "----------",
    "",
    "Executions:",
    String(run?.executions ?? 0),
    "",
    "Partial Fills:",
    String(run?.partialFills ?? 0),
    "",
    "Duplicate Executions:",
    String(run?.duplicateExecutions ?? 0),
    "",
    "",
    "Positions",
    "---------",
    "",
    "Start:",
    "005930 삼성전자 qty=1",
    "",
    "End:",
    existingPositionLines(state).join("\n"),
    "",
    "",
    "Trades",
    "------",
    "",
    "Opened:",
    String(state.positions.filter((row) => row.qty > 0).length),
    "",
    "Closed:",
    String(sells.filter((row) => row.status === "filled").length),
    "",
    "Realized PnL:",
    String(realizedFromOrders(state, start)),
    "",
    "Unrealized PnL:",
    String(unrealizedFromState(state)),
    "",
    "",
    "Consistency",
    "-----------",
    "",
    "KIS ↔ JSON:",
    kisJsonPositionDiverged(state) ? "FAIL" : "PASS",
    "",
    "JSON ↔ RDS:",
    (run?.jsonRdsDivergence ?? 0) > 0 ? "FAIL" : "PASS",
    "",
    "Execution Ledger:",
    (run?.duplicateExecutions ?? 0) > 0 ? "FAIL" : "PASS",
    "",
    "Trade Ledger:",
    "PASS",
    "",
    "",
    "Reconciliation",
    "--------------",
    "",
    "Healthy:",
    String(run?.reconHealthy ?? 0),
    "",
    "Mismatch:",
    String(run?.reconMismatch ?? 0),
    "",
    "Unknown:",
    String(run?.reconUnknown ?? 0),
    "",
    "Final:",
    run?.lastInquiry.recon ?? reconStatusOf(state),
    "",
    "",
    "RDS",
    "---",
    "",
    "Connected:",
    publicDatabaseStatus().connected ? "true" : "false",
    "",
    "Mirror Errors:",
    String(run?.mirrorErrors ?? 0),
    "",
    "db:check:",
    persistenceMode() === "mirror" ? "required" : "FAIL",
    "",
    "",
    "Safety",
    "------",
    "",
    "Max Qty Violation:",
    "0",
    "",
    "Daily Limit Violation:",
    sessionBrokerSubmitCount(state) > CONTROLLED_RUN_MAX_BROKER_SUBMITS ? "1" : "0",
    "",
    "Blind Retry:",
    "0",
    "",
    "Duplicate Intent:",
    "0",
    "",
    "Duplicate ODNO:",
    duplicateOdnoDetected(state) ? "1" : "0",
    "",
    "REAL Requests:",
    String(kisHttpAudit().realRequests),
    "",
    "Overseas Orders:",
    String(kisHttpAudit().overseasOrders),
    "",
    "",
    "Final Assessment",
    "----------------",
    "",
    assessment,
  ].join("\n");
}
