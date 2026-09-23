import type { AppState, AutoCondition, Order, OrderIntent } from "@/lib/types";
import { accountValue } from "@/src/accounts/portfolio";
import { UNIVERSE } from "@/lib/universe";
import { US_SEED_UNIVERSE } from "@/src/markets/overseas/instruments";
import { HARD_LIMITS } from "@/src/risk/limits";
import { paperOperationPolicy } from "@/src/risk/order-policy";
import { getRuleConfig } from "@/src/rules/config";
import { CASH_RULE_ID } from "@/src/rules/params";
import type { EnvMap } from "@/src/runtime/trading-mode";
import { bootstrapUserEmail } from "@/src/db/config";
import { newId, stableId } from "@/src/db/ids";
import type { Ledger, LedgerSession } from "@/src/db/ledger";
import {
  credentialRef,
  describeInstrument,
  executionKeyFor,
  fillChildren,
  ledgerBroker,
  ledgerEnvironment,
  mapIntentStatus,
  mapOrderStatus,
  mapSide,
  maskedAccount,
  parentOrders,
} from "@/src/db/mapping";
import { money, moneyNumber } from "@/src/db/money";
import { mysqlDateUtc, toMysqlUtc } from "@/src/db/time";
import { applyExecutionToTrade, openTrade } from "@/src/db/trade-cycle";
import type { ExecutionRow, OrderRow, PositionRow, ReconItemRow } from "@/src/db/rows";
import {
  assertActivePaperFingerprint,
  planMirrorPaperBrokerAccount,
} from "@/src/db/mirror-paper-ownership";
import { findOrderByIntent } from "@/src/runtime/intents";
import {
  domesticCashRowsFromState,
  reconProjectionFromState,
  shouldSkipReconPersist,
} from "@/src/risk/kis-balance-semantics";

export type MirrorContext = {
  env?: EnvMap;
  provenance?: "RUNTIME" | "LEGACY_STATE";
  cash?: Array<{ currency: string; cashBalance: number; orderableAmount: number; source?: string }>;
  fx?: { baseCurrency: string; quoteCurrency: string; rate: number; source: string };
  recon?: {
    triggerType?: string;
    status: "HEALTHY" | "MISMATCH" | "UNKNOWN";
    items: Array<{
      itemType: string;
      status: string;
      message?: string | null;
      localReference?: string | null;
      brokerReference?: string | null;
      instrumentId?: string | null;
      localValueJson?: unknown;
      brokerValueJson?: unknown;
    }>;
  };
  sourcePath?: string;
};

export type ProjectResult = {
  userId: string;
  brokerAccountId: string;
  environment: string;
  imported: {
    intents: number;
    orders: number;
    executions: number;
    positions: number;
    rules: number;
  };
  warnings: string[];
};

function fillSequenceUtc(createdAt: string, seq: number): string {
  const ms = new Date(createdAt).getTime();
  return toMysqlUtc(Number.isFinite(ms) ? ms + seq : seq);
}

function eventTypeFor(status: string, first: boolean): string {
  if (first) return "CREATED";
  if (status === "SUBMITTED" || status === "PENDING") return "SUBMITTED";
  if (status === "ACCEPTED") return "ACKNOWLEDGED";
  if (status === "PARTIALLY_FILLED") return "PARTIAL_FILL";
  if (status === "FILLED") return "FILLED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "UNKNOWN") return "UNKNOWN";
  if (status === "REJECTED") return "REJECTED";
  return status;
}

function intentSourceOf(intent: OrderIntent): string {
  const signal = intent.signalId.toLowerCase();
  if (signal.includes("manual")) return "MANUAL";
  if (signal.includes("dca")) return "DCA";
  if (signal.includes("condition")) return "CONDITION";
  return "RULE";
}

function conditionStatus(status: AutoCondition["status"]): string {
  if (status === "watching") return "ACTIVE";
  if (status === "paused") return "PAUSED";
  if (status === "filled" || status === "expired") return "COMPLETED";
  return "DISABLED";
}

function knownCodes(state: AppState): string[] {
  const codes = new Set<string>();
  for (const row of UNIVERSE) codes.add(row.code);
  for (const row of US_SEED_UNIVERSE) codes.add(`${row.exchange}:${row.symbol}`);
  for (const pos of state.positions) codes.add(pos.code);
  for (const order of state.orders) codes.add(order.code);
  for (const intent of state.intents ?? []) codes.add(intent.ticker);
  for (const cond of state.conditions) codes.add(cond.code);
  for (const plan of state.dcaPlans) codes.add(plan.code);
  return [...codes].filter(Boolean);
}

async function ensureInstrument(tx: LedgerSession, code: string) {
  const info = describeInstrument(code);
  return tx.upsertInstrument({
    id: info.id,
    country: info.country,
    market: info.market,
    symbol: info.symbol,
    displayName: info.displayName,
    currency: info.currency,
    kisExchangeCode: info.kisExchangeCode,
    instrumentType: "STOCK",
    isActive: true,
  });
}

async function maybeAppendEvent(tx: LedgerSession, order: OrderRow, first: boolean) {
  const last = await tx.lastOrderEvent(order.id);
  if (last && last.newStatus === order.status) return;
  const eventType = eventTypeFor(order.status, first && !last);
  await tx.appendOrderEvent({
    id: newId(),
    orderId: order.id,
    eventType,
    previousStatus: last?.newStatus ?? null,
    newStatus: order.status,
    eventAt: toMysqlUtc(order.updatedAt),
  });
}

function realizedFromState(state: AppState): number {
  return state.orders
    .filter((order) => order.status === "filled" && order.side === "sell")
    .reduce((sum, order) => sum + (order.realizedPnl ?? 0), 0);
}

function unrealizedFromState(state: AppState): number {
  return state.positions.reduce((sum, pos) => {
    const last = state.quotes[pos.code]?.price ?? pos.avgPrice;
    return sum + (last - pos.avgPrice) * pos.qty;
  }, 0);
}

export async function projectAppState(
  ledger: Ledger,
  state: AppState,
  context: MirrorContext = {},
): Promise<ProjectResult> {
  const env = context.env ?? process.env;
  const warnings: string[] = [];
  return ledger.transaction(async (tx) => {
    const environment = ledgerEnvironment(env);
    const broker = ledgerBroker(env);
    const email = bootstrapUserEmail(env);
    const now = toMysqlUtc(state.updatedAt);
    const user = await tx.upsertUser({
      id: stableId("user", email.toLowerCase()),
      email,
      displayName: "LOCAL_OWNER",
      role: "USER",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    const paperPlan = planMirrorPaperBrokerAccount(broker, environment, env);
    assertActivePaperFingerprint(
      broker,
      environment,
      paperPlan.status,
      paperPlan.physicalAccountFingerprint,
    );
    const brokerAccount = await tx.upsertBrokerAccount({
      id: stableId("broker-account", `${user.id}:${broker}:${environment}`),
      userId: user.id,
      broker,
      environment,
      displayName: `${broker} ${environment}`,
      accountNumberMasked: maskedAccount(env),
      baseCurrency: "KRW",
      status: paperPlan.status,
      isDefault: paperPlan.isDefault,
      credentialRef: credentialRef(env),
      physicalAccountFingerprint: paperPlan.physicalAccountFingerprint,
    });
    if (brokerAccount.credentialRef) {
      await tx.upsertCredentialRef(brokerAccount.id, brokerAccount.credentialRef);
    }

    for (const code of knownCodes(state)) {
      await ensureInstrument(tx, code);
    }

    const rules = getRuleConfig().rules ?? [];
    const ruleKeys = new Set<string>([CASH_RULE_ID, ...state.allocations.map((row) => row.ruleId), ...rules.map((row) => row.id)]);
    for (const key of ruleKeys) {
      const cfg = rules.find((row) => row.id === key);
      const instrumentId = cfg?.ticker ? (await ensureInstrument(tx, cfg.ticker)).id : null;
      await tx.upsertTradingRule({
        id: stableId("trading-rule", `${brokerAccount.id}:${key}`),
        userId: user.id,
        brokerAccountId: brokerAccount.id,
        ruleKey: key,
        instrumentId,
        name: cfg?.name || (key === CASH_RULE_ID ? "cash" : key),
        kind: cfg?.kind ?? (key === CASH_RULE_ID ? "CASH" : "RULE"),
        intervalMs: cfg?.intervalMs ?? null,
        fastMa: cfg?.fastMa ?? null,
        slowMa: cfg?.slowMa ?? null,
        buyPct: cfg ? money(cfg.buyPct) : null,
        sliceAmount: cfg ? money(cfg.sliceKrw) : null,
        minAmount: cfg ? money(cfg.minAmountKrw) : null,
        stopLossPct: cfg ? money(cfg.stopLossPct) : null,
        takeProfitPct: cfg ? money(cfg.takeProfitPct) : null,
        budget: money(cfg?.budget ?? state.allocations.find((row) => row.ruleId === key)?.budget ?? 0),
        enabled: cfg?.enabled ?? state.allocations.find((row) => row.ruleId === key)?.enabled ?? true,
        configJson: cfg ?? null,
      });
    }
    for (const alloc of state.allocations) {
      await tx.upsertRuleAllocation({
        id: stableId("rule-alloc", `${brokerAccount.id}:${alloc.ruleId}`),
        brokerAccountId: brokerAccount.id,
        ruleKey: alloc.ruleId,
        budget: money(Math.max(0, alloc.budget)),
        balance: money(Math.max(0, alloc.balance)),
        enabled: alloc.enabled,
        lastRunAt: alloc.lastRunAt ? toMysqlUtc(alloc.lastRunAt) : null,
        lastMessage: alloc.lastMessage ?? null,
        metaJson: alloc.meta ?? null,
      });
    }

    for (const cond of state.conditions) {
      const instrument = cond.code ? await ensureInstrument(tx, cond.code) : null;
      await tx.upsertAutoCondition({
        id: stableId("auto-condition", `${brokerAccount.id}:${cond.id}`),
        brokerAccountId: brokerAccount.id,
        conditionKey: cond.id,
        instrumentId: instrument?.id ?? null,
        status: conditionStatus(cond.status),
        configJson: cond,
      });
    }
    for (const plan of state.dcaPlans) {
      if (!plan.code) continue;
      const instrument = await ensureInstrument(tx, plan.code);
      await tx.upsertDcaPlan({
        id: stableId("dca-plan", `${brokerAccount.id}:${plan.id}`),
        brokerAccountId: brokerAccount.id,
        planKey: plan.id,
        instrumentId: instrument.id,
        status: plan.enabled ? "ACTIVE" : "PAUSED",
        configJson: plan,
        nextRunAt: plan.nextRunAt ? toMysqlUtc(plan.nextRunAt) : null,
        lastRunAt: null,
      });
    }

    const prevState = await tx.getTradingAccountState(brokerAccount.id);
    await tx.upsertTradingAccountState({
      brokerAccountId: brokerAccount.id,
      autoTradingEnabled: Boolean(state.settings.autoTrading),
      onboardingComplete: Boolean(state.settings.onboardingComplete),
      liquidating: Boolean(state.settings.liquidating),
      circuitHalted: Boolean(state.circuit.halted),
      circuitKind: state.circuit.kind ?? null,
      circuitReason: state.circuit.reason ?? null,
      unknownOrderCount: state.circuit.unknownCount ?? 0,
    });
    await writeAudits(tx, prevState, state, user.id, brokerAccount.id);

    if (environment === "PAPER" || environment === "MOCK") {
      const paper = paperOperationPolicy(context.env ?? process.env);
      await tx.upsertRiskLimits({
        id: stableId("risk-limits", `${brokerAccount.id}:${environment}`),
        brokerAccountId: brokerAccount.id,
        environment,
        maxOrderAmount: null,
        maxOrderQty: money(paper.maxQtyPerOrder),
        maxDailyOrderAmount: null,
        maxDailyOrders: paper.maxBrokerSubmitsPerDay,
        maxPositionAmount: null,
        maxDailyLoss: null,
        allowTrading: false,
      });
    } else {
      await tx.upsertRiskLimits({
        id: stableId("risk-limits", `${brokerAccount.id}:${environment}`),
        brokerAccountId: brokerAccount.id,
        environment,
        maxOrderAmount: money(HARD_LIMITS.maxOrderKrw),
        maxOrderQty: null,
        maxDailyOrderAmount: money(HARD_LIMITS.maxDailyBuyKrw),
        maxDailyOrders: HARD_LIMITS.maxDailyOrders,
        maxPositionAmount: null,
        maxDailyLoss: null,
        allowTrading: false,
      });
    }

    let importedIntents = 0;
    for (const intent of state.intents ?? []) {
      if (intent.qty <= 0) continue;
      const instrument = await ensureInstrument(tx, intent.ticker);
      const linked = findOrderByIntent(state, intent.intentId);
      const status = mapIntentStatus(intent, linked);
      const completed =
        status === "FILLED" || status === "REJECTED" || status === "CANCELLED"
          ? toMysqlUtc(linked?.createdAt ?? intent.createdAt)
          : null;
      const result = await tx.upsertIntent({
        id: stableId("intent", `${brokerAccount.id}:${intent.intentId}`),
        brokerAccountId: brokerAccount.id,
        instrumentId: instrument.id,
        intentKey: intent.intentId.slice(0, 191),
        ruleKey: intent.ruleId || CASH_RULE_ID,
        source: intentSourceOf(intent),
        side: mapSide(intent.side),
        quantity: money(intent.qty),
        referencePrice: money(intent.price),
        orderType: "MARKET",
        tradingMode: environment,
        status,
        reason: intent.reason ?? null,
        createdAt: toMysqlUtc(intent.createdAt),
        updatedAt: now,
        completedAt: completed,
      });
      if (result.inserted) importedIntents += 1;
      if (!(await tx.hasRiskDecision(result.row.id))) {
        const decision = riskDecisionFor(intent, state);
        if (decision) {
          await tx.insertRiskDecision({
            id: stableId("risk-decision", `${result.row.id}:${decision.decision}`),
            intentId: result.row.id,
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            reasonText: intent.reason ?? null,
            requestedQty: money(intent.qty),
            requestedAmount: money(intent.qty * intent.price),
          });
        }
      }
    }

    let importedOrders = 0;
    let importedExecutions = 0;
    const parents = [...parentOrders(state)].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return state.orders.indexOf(b) - state.orders.indexOf(a);
    });
    for (const [index, parent] of parents.entries()) {
      const requested = parent.orderedQty ?? parent.qty;
      if (requested <= 0) continue;
      const instrument = await ensureInstrument(tx, parent.code);
      const filled = parent.filledQty ?? (parent.status === "filled" ? parent.qty : 0);
      const remaining = Math.max(0, requested - filled);
      const intent = (state.intents ?? []).find((row) => row.intentId === parent.intentId);
      const intentRow = intent ? await tx.getIntentByKey(brokerAccount.id, intent.intentId.slice(0, 191)) : undefined;
      const status = mapOrderStatus(parent);
      const result = await tx.upsertOrder({
        id: stableId("order", `${brokerAccount.id}:${parent.id}`),
        brokerAccountId: brokerAccount.id,
        instrumentId: instrument.id,
        intentId: intentRow?.id ?? null,
        localOrderId: parent.id.slice(0, 191),
        brokerOrderNo: parent.brokerOrderNo ?? null,
        brokerOrderDate: parent.brokerOrderNo ? mysqlDateUtc(parent.createdAt) : null,
        brokerOrgNo: parent.krxOrgNo ?? null,
        side: mapSide(parent.side),
        orderType: parent.ordDvsn === "limit" ? "LIMIT" : "MARKET",
        requestedQty: money(requested),
        requestedPrice: money(parent.price),
        filledQty: money(filled),
        remainingQty: money(remaining),
        averageFillPrice: filled > 0 ? money(parent.price) : null,
        currency: instrument.currency,
        status,
        source: parent.source?.toUpperCase() ?? null,
        sourceId: parent.sourceId ?? null,
        ruleKey: parent.ruleId || CASH_RULE_ID,
        reason: parent.reason ?? null,
        submittedAt: parent.brokerOrderNo ? toMysqlUtc(parent.createdAt) : null,
        acceptedAt: parent.brokerOrderNo ? toMysqlUtc(parent.createdAt) : null,
        completedAt: status === "FILLED" || status === "CANCELLED" || status === "REJECTED" ? toMysqlUtc(parent.createdAt) : null,
        createdAt: toMysqlUtc(parent.createdAt),
        updatedAt: now,
      });
      if (result.inserted) importedOrders += 1;
      await maybeAppendEvent(tx, result.row, result.inserted);

      const children = [...fillChildren(state, parent.id)].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return state.orders.indexOf(b) - state.orders.indexOf(a);
      });
      if (children.length > 0) {
        let cumulative = 0;
        for (const [childIndex, child] of children.entries()) {
          if (child.qty <= 0) continue;
          cumulative += child.qty;
          const inserted = await insertExecution(tx, {
            accountId: brokerAccount.id,
            orderId: result.row.id,
            instrumentId: instrument.id,
            currency: instrument.currency,
            order: child,
            parent,
            cumulativeQty: cumulative,
            executedAt: fillSequenceUtc(child.createdAt, index * 10 + childIndex),
          });
          if (inserted) importedExecutions += 1;
        }
      } else if (parent.status === "filled" && (parent.filledQty ?? parent.qty) > 0 && !parent.parentOrderId) {
        const qty = parent.filledQty ?? parent.qty;
        const inserted = await insertExecution(tx, {
          accountId: brokerAccount.id,
          orderId: result.row.id,
          instrumentId: instrument.id,
          currency: instrument.currency,
          order: parent,
          parent: undefined,
          cumulativeQty: qty,
          executedAt: fillSequenceUtc(parent.createdAt, index * 10),
        });
        if (inserted) importedExecutions += 1;
      }
    }

    await projectTrades(tx, brokerAccount.id);

    const executedInstruments = new Set<string>();
    for (const parent of parentOrders(state)) {
      const children = fillChildren(state, parent.id);
      if (children.length > 0 || parent.status === "filled") {
        executedInstruments.add((await ensureInstrument(tx, parent.code)).id);
      }
    }

    let importedPositions = 0;
    const seenScopes = new Set<string>();
    for (const pos of state.positions) {
      const instrument = await ensureInstrument(tx, pos.code);
      const quote = state.quotes[pos.code];
      const last = quote?.price ?? pos.avgPrice;
      const provenance =
        context.provenance === "LEGACY_STATE" && !executedInstruments.has(instrument.id) ? "LEGACY_STATE" : "RUNTIME";
      const row: PositionRow = {
        id: stableId("position", `${brokerAccount.id}:${instrument.id}:${pos.ruleId}`),
        brokerAccountId: brokerAccount.id,
        instrumentId: instrument.id,
        ruleScope: pos.ruleId || CASH_RULE_ID,
        quantity: money(Math.max(0, pos.qty)),
        availableQuantity: money(Math.max(0, pos.qty)),
        averagePrice: money(Math.max(0, pos.avgPrice)),
        totalCost: money(Math.max(0, pos.qty * pos.avgPrice)),
        marketPrice: quote ? money(last) : money(pos.avgPrice),
        marketValue: money(pos.qty * last),
        unrealizedPnl: money((last - pos.avgPrice) * pos.qty),
        unrealizedReturnPct: pos.avgPrice > 0 ? money(((last - pos.avgPrice) / pos.avgPrice) * 100) : null,
        currency: instrument.currency,
        provenance,
        updatedAt: now,
      };
      await tx.upsertPosition(row);
      seenScopes.add(`${instrument.id}:${row.ruleScope}`);
      importedPositions += 1;
    }
    for (const existing of await tx.listPositions(brokerAccount.id)) {
      const key = `${existing.instrumentId}:${existing.ruleScope}`;
      if (!seenScopes.has(key) && moneyNumber(existing.quantity) > 0) {
        await tx.upsertPosition({
          ...existing,
          quantity: money(0),
          availableQuantity: money(0),
          marketValue: money(0),
          unrealizedPnl: money(0),
          updatedAt: now,
        });
      }
    }

    await snapshotCash(tx, brokerAccount.id, state, context, now);
    await snapshotAccount(tx, brokerAccount.id, state, now);
    if (context.fx && context.fx.rate > 0) {
      await tx.insertFxSnapshot({
        id: newId(),
        baseCurrency: context.fx.baseCurrency,
        quoteCurrency: context.fx.quoteCurrency,
        rate: money(context.fx.rate),
        source: context.fx.source,
        capturedAt: now,
      });
    }
    await snapshotRecon(tx, brokerAccount.id, state, context, now);

    return {
      userId: user.id,
      brokerAccountId: brokerAccount.id,
      environment,
      imported: {
        intents: importedIntents,
        orders: importedOrders,
        executions: importedExecutions,
        positions: importedPositions,
        rules: ruleKeys.size,
      },
      warnings,
    };
  });
}

async function insertExecution(
  tx: LedgerSession,
  input: {
    accountId: string;
    orderId: string;
    instrumentId: string;
    currency: string;
    order: Order;
    parent: Order | undefined;
    cumulativeQty: number;
    executedAt?: string;
  },
): Promise<boolean> {
  const key = executionKeyFor(input.order, input.parent, input.cumulativeQty);
  const qty = input.order.qty;
  if (qty <= 0) return false;
  const odno = input.order.brokerOrderNo ?? input.parent?.brokerOrderNo;
  if (odno) {
    const existingOdno = await tx.findExecutionByBrokerOrderNo(input.accountId, odno);
    if (existingOdno && moneyNumber(existingOdno.quantity) === qty) return false;
  }
  const price = input.order.price;
  const at = input.executedAt ?? toMysqlUtc(input.order.createdAt);
  const result = await tx.insertExecution({
    id: stableId("execution", `${input.accountId}:${key}`),
    brokerAccountId: input.accountId,
    orderId: input.orderId,
    instrumentId: input.instrumentId,
    tradeId: null,
    executionKey: key.slice(0, 191),
    brokerExecutionId: null,
    brokerOrderNo: input.order.brokerOrderNo ?? input.parent?.brokerOrderNo ?? null,
    side: mapSide(input.order.side),
    quantity: money(qty),
    price: money(Math.max(0, price)),
    grossAmount: money(qty * price),
    commission: money(Math.max(0, input.order.commission ?? 0)),
    tax: money(Math.max(0, input.order.tax ?? 0)),
    otherFee: money(0),
    realizedPnl: input.order.realizedPnl == null ? null : money(input.order.realizedPnl),
    currency: input.currency,
    executedAt: at,
    createdAt: at,
  });
  return result.inserted;
}

async function projectTrades(tx: LedgerSession, accountId: string): Promise<void> {
  const unlinked = await tx.listUnlinkedExecutions(accountId);
  for (const execution of unlinked) {
    const parent = await tx.getOrder(execution.orderId);
    const ruleScope = parent?.ruleKey || CASH_RULE_ID;
    let trade = await tx.getOpenTrade(accountId, execution.instrumentId, ruleScope);
    if (!trade) {
      trade = openTrade({
        brokerAccountId: accountId,
        instrumentId: execution.instrumentId,
        ruleScope,
        source: parent?.source ?? "RULE",
        currency: execution.currency,
        openedAt: execution.executedAt,
      });
    }
    const next = applyExecutionToTrade(trade, execution);
    await tx.upsertTrade(next);
    await tx.linkExecutionTrade(execution.id, next.id);
  }
}

async function snapshotCash(
  tx: LedgerSession,
  accountId: string,
  state: AppState,
  context: MirrorContext,
  now: string,
) {
  const rows =
    context.cash && context.cash.length > 0 ? context.cash : domesticCashRowsFromState(state);
  for (const row of rows) {
    const last = await tx.lastCashSnapshot(accountId, row.currency);
    if (
      last &&
      last.cashBalance === money(row.cashBalance) &&
      last.orderableAmount === money(row.orderableAmount)
    ) {
      continue;
    }
    await tx.insertCashSnapshot({
      id: newId(),
      brokerAccountId: accountId,
      currency: row.currency,
      cashBalance: money(row.cashBalance),
      orderableAmount: money(row.orderableAmount),
      withdrawableAmount: null,
      source: row.source ?? "LOCAL_STATE",
      capturedAt: now,
    });
  }
}

async function snapshotAccount(tx: LedgerSession, accountId: string, state: AppState, now: string) {
  const total = accountValue(state);
  const cash = state.cash;
  const stock = total - cash;
  const realized = realizedFromState(state);
  const unrealized = unrealizedFromState(state);
  const last = await tx.lastAccountSnapshot(accountId);
  if (
    last &&
    last.totalAssetValue === money(total) &&
    last.cashValue === money(cash) &&
    last.stockMarketValue === money(stock)
  ) {
    return;
  }
  await tx.insertAccountSnapshot({
    id: newId(),
    brokerAccountId: accountId,
    baseCurrency: "KRW",
    totalAssetValue: money(total),
    cashValue: money(cash),
    stockMarketValue: money(stock),
    realizedPnl: money(realized),
    unrealizedPnl: money(unrealized),
    capturedAt: now,
  });
}

async function snapshotRecon(
  tx: LedgerSession,
  accountId: string,
  state: AppState,
  context: MirrorContext,
  now: string,
) {
  const recon = context.recon ? context.recon : reconProjectionFromState(state, context.env);
  if (!recon) return;
  const last = await tx.lastReconRun(accountId);
  if (shouldSkipReconPersist(last, recon, state.kisBalance?.fetchedAt ?? state.kisBalance?.syncedAt)) return;
  const runId = newId();
  await tx.insertReconRun({
    id: runId,
    brokerAccountId: accountId,
    triggerType: recon.triggerType ?? "SCHEDULED",
    status: recon.status,
    startedAt: now,
    finishedAt: now,
  });
  for (const item of recon.items) {
    await tx.insertReconItem({
      id: newId(),
      reconciliationRunId: runId,
      itemType: item.itemType,
      instrumentId: item.instrumentId ?? null,
      localReference: item.localReference ?? null,
      brokerReference: item.brokerReference ?? null,
      localValueJson: item.localValueJson ?? null,
      brokerValueJson: item.brokerValueJson ?? null,
      status: item.status,
      message: item.message ?? null,
    });
  }
}

function riskDecisionFor(intent: OrderIntent, state: AppState): { decision: "ALLOW" | "DENY" | "BLOCK"; reasonCode: string } | null {
  if (intent.status === "rejected") {
    const reason = (intent.reason ?? "").toLowerCase();
    if (reason.includes("recon") || reason.includes("장부") || state.circuit.kind === "recon") {
      return { decision: "BLOCK", reasonCode: "RECONCILIATION_MISMATCH" };
    }
    if (reason.includes("한도") || reason.includes("limit") || reason.includes("hard")) {
      return { decision: "DENY", reasonCode: "REAL_HARD_LIMIT" };
    }
    return { decision: "DENY", reasonCode: "REJECTED" };
  }
  if (intent.status === "submitted" || intent.status === "filled") {
    return { decision: "ALLOW", reasonCode: "SUBMITTED" };
  }
  return null;
}

async function writeAudits(
  tx: LedgerSession,
  prev: Awaited<ReturnType<LedgerSession["getTradingAccountState"]>>,
  state: AppState,
  userId: string,
  accountId: string,
) {
  const write = async (action: string, before: unknown, after: unknown) => {
    await tx.insertAudit({
      id: newId(),
      userId,
      brokerAccountId: accountId,
      action,
      entityType: "trading_account_state",
      entityId: accountId,
      beforeDataJson: before,
      afterDataJson: after,
    });
  };
  if (prev && prev.autoTradingEnabled !== Boolean(state.settings.autoTrading)) {
    await write(
      state.settings.autoTrading ? "AUTO_TRADING_ENABLED" : "AUTO_TRADING_DISABLED",
      { autoTradingEnabled: prev.autoTradingEnabled },
      { autoTradingEnabled: state.settings.autoTrading },
    );
  }
  if (prev && prev.liquidating !== Boolean(state.settings.liquidating) && state.settings.liquidating) {
    await write("FLATTEN_REQUESTED", { liquidating: prev.liquidating }, { liquidating: true });
  }
  if (prev && prev.circuitHalted !== Boolean(state.circuit.halted) && state.circuit.halted) {
    await write("EMERGENCY_STOP", { circuitHalted: prev.circuitHalted }, { kind: state.circuit.kind, reason: state.circuit.reason });
  }
}
