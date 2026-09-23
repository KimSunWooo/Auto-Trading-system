import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, type AppDb } from "@/src/db/client";
import type { Ledger, LedgerSession } from "@/src/db/ledger";
import { decodeCursor, encodeCursor } from "@/src/db/ledger";
import * as schema from "@/src/db/schema";
import type {
  AccountSnapshotRow,
  AuditLogRow,
  AutoConditionRow,
  BrokerAccountRow,
  BuyHistoryRow,
  CashSnapshotRow,
  DcaPlanRow,
  ExecutionRow,
  FxSnapshotRow,
  HistoryFilter,
  InstrumentRow,
  IntentRow,
  MigrationRunRow,
  OrderEventRow,
  OrderRow,
  Page,
  PositionRow,
  ReconItemRow,
  ReconRunRow,
  RiskDecisionRow,
  RiskLimitsRow,
  RuleAllocationRow,
  TradeRow,
  TradingAccountStateRow,
  TradingRuleRow,
  UserRow,
} from "@/src/db/rows";
import { moneyNumber } from "@/src/db/money";
import { newId } from "@/src/db/ids";
import type { EnvMap } from "@/src/runtime/trading-mode";
import { sameOdno } from "@/src/brokers/kis-client";

type Tx = AppDb;

function clampLimit(limit?: number): number {
  const n = Number(limit ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export class MysqlSession implements LedgerSession {
  constructor(private readonly db: Tx) {}

  async upsertUser(row: UserRow): Promise<UserRow> {
    await this.db
      .insert(schema.users)
      .values({
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
      .onDuplicateKeyUpdate({
        set: { displayName: row.displayName, status: row.status, updatedAt: row.updatedAt },
      });
    return row;
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  async upsertBrokerAccount(row: BrokerAccountRow): Promise<BrokerAccountRow> {
    if (
      row.broker.toLowerCase() === "kis" &&
      row.environment.toUpperCase() === "PAPER" &&
      row.status === "ACTIVE" &&
      (row.physicalAccountFingerprint == null || row.physicalAccountFingerprint === "")
    ) {
      throw new Error("ACTIVE kis/PAPER broker_account requires physicalAccountFingerprint");
    }

    const insertValues: {
      id: string;
      userId: string;
      broker: string;
      environment: string;
      displayName: string;
      accountNumberMasked: string | null;
      baseCurrency: string;
      status: string;
      isDefault: boolean;
      credentialRef: string | null;
      physicalAccountFingerprint?: string | null;
    } = {
      id: row.id,
      userId: row.userId,
      broker: row.broker,
      environment: row.environment,
      displayName: row.displayName,
      accountNumberMasked: row.accountNumberMasked,
      baseCurrency: row.baseCurrency,
      status: row.status,
      isDefault: row.isDefault,
      credentialRef: row.credentialRef,
    };
    if (row.physicalAccountFingerprint !== undefined) {
      insertValues.physicalAccountFingerprint = row.physicalAccountFingerprint;
    }

    const updateSet: {
      displayName: string;
      accountNumberMasked: string | null;
      isDefault: boolean;
      credentialRef: string | null;
      status?: string;
      physicalAccountFingerprint?: string | null;
    } = {
      displayName: row.displayName,
      accountNumberMasked: row.accountNumberMasked,
      // Do not force ACTIVE — preserves DISABLED physical-ownership releases.
      isDefault: row.isDefault,
      credentialRef: row.credentialRef,
    };
    // Mirror accounts-owner path may force DISABLED on the bootstrap row.
    if (row.status === "DISABLED") {
      updateSet.status = "DISABLED";
    }
    if (row.physicalAccountFingerprint !== undefined) {
      updateSet.physicalAccountFingerprint = row.physicalAccountFingerprint;
    }

    await this.db
      .insert(schema.brokerAccounts)
      .values(insertValues)
      .onDuplicateKeyUpdate({
        set: updateSet,
      });
    return row;
  }

  async listBrokerAccounts(): Promise<BrokerAccountRow[]> {
    const rows = await this.db.select().from(schema.brokerAccounts);
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      broker: row.broker,
      environment: row.environment,
      displayName: row.displayName,
      accountNumberMasked: row.accountNumberMasked,
      baseCurrency: row.baseCurrency,
      status: row.status,
      isDefault: Boolean(row.isDefault),
      credentialRef: row.credentialRef,
      physicalAccountFingerprint: row.physicalAccountFingerprint ?? null,
    }));
  }

  async upsertCredentialRef(accountId: string, secretRef: string): Promise<void> {
    await this.db
      .insert(schema.brokerCredentialRefs)
      .values({
        id: newId(),
        brokerAccountId: accountId,
        secretProvider: "ENV",
        secretRef,
      })
      .onDuplicateKeyUpdate({ set: { secretRef } });
  }

  async upsertInstrument(row: InstrumentRow): Promise<InstrumentRow> {
    await this.db
      .insert(schema.instruments)
      .values({
        id: row.id,
        country: row.country,
        market: row.market,
        symbol: row.symbol,
        displayName: row.displayName,
        koreanName: row.koreanName ?? null,
        englishName: row.englishName ?? null,
        currency: row.currency,
        kisExchangeCode: row.kisExchangeCode,
        instrumentType: row.instrumentType,
        isActive: row.isActive,
      })
      .onDuplicateKeyUpdate({
        set: {
          displayName: row.displayName,
          koreanName: row.koreanName ?? null,
          englishName: row.englishName ?? null,
          kisExchangeCode: row.kisExchangeCode,
          isActive: row.isActive,
        },
      });
    return row;
  }

  async getInstrument(id: string): Promise<InstrumentRow | undefined> {
    const rows = await this.db.select().from(schema.instruments).where(eq(schema.instruments.id, id)).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      country: row.country,
      market: row.market,
      symbol: row.symbol,
      displayName: row.displayName,
      koreanName: row.koreanName ?? null,
      englishName: row.englishName ?? null,
      currency: row.currency,
      kisExchangeCode: row.kisExchangeCode,
      instrumentType: row.instrumentType,
      isActive: Boolean(row.isActive),
    };
  }

  async upsertIntent(row: IntentRow): Promise<{ row: IntentRow; inserted: boolean }> {
    const existing = await this.getIntentByKey(row.brokerAccountId, row.intentKey);
    await this.db
      .insert(schema.orderIntents)
      .values({
        id: existing?.id ?? row.id,
        brokerAccountId: row.brokerAccountId,
        instrumentId: row.instrumentId,
        intentKey: row.intentKey,
        ruleKey: row.ruleKey,
        source: row.source,
        side: row.side,
        quantity: row.quantity,
        referencePrice: row.referencePrice,
        orderType: row.orderType,
        tradingMode: row.tradingMode,
        status: row.status,
        reason: row.reason,
        createdAt: existing?.createdAt ?? row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: row.status,
          reason: row.reason,
          updatedAt: row.updatedAt,
          completedAt: row.completedAt,
        },
      });
    return { row: { ...row, id: existing?.id ?? row.id }, inserted: !existing };
  }

  async getIntentByKey(accountId: string, intentKey: string): Promise<IntentRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.orderIntents)
      .where(and(eq(schema.orderIntents.brokerAccountId, accountId), eq(schema.orderIntents.intentKey, intentKey)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      instrumentId: row.instrumentId,
      intentKey: row.intentKey,
      ruleKey: row.ruleKey,
      source: row.source,
      side: row.side,
      quantity: String(row.quantity),
      referencePrice: row.referencePrice == null ? null : String(row.referencePrice),
      orderType: row.orderType,
      tradingMode: row.tradingMode,
      status: row.status,
      reason: row.reason,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      completedAt: row.completedAt == null ? null : String(row.completedAt),
    };
  }

  async upsertOrder(row: OrderRow): Promise<{ row: OrderRow; inserted: boolean }> {
    const existing =
      (await this.getOrderByLocalId(row.brokerAccountId, row.localOrderId)) ??
      (row.brokerOrderNo
        ? await this.getOrderByBrokerOrderNo(row.brokerAccountId, row.brokerOrderNo, row.brokerOrderDate)
        : undefined);
    await this.db
      .insert(schema.orders)
      .values({
        id: existing?.id ?? row.id,
        brokerAccountId: row.brokerAccountId,
        instrumentId: row.instrumentId,
        intentId: row.intentId,
        localOrderId: row.localOrderId,
        brokerOrderNo: row.brokerOrderNo,
        brokerOrderDate: row.brokerOrderDate,
        brokerOrgNo: row.brokerOrgNo,
        side: row.side,
        orderType: row.orderType,
        requestedQty: row.requestedQty,
        requestedPrice: row.requestedPrice,
        filledQty: row.filledQty,
        remainingQty: row.remainingQty,
        averageFillPrice: row.averageFillPrice,
        currency: row.currency,
        status: row.status,
        source: row.source,
        sourceId: row.sourceId,
        ruleKey: row.ruleKey,
        reason: row.reason,
        submittedAt: row.submittedAt,
        acceptedAt: row.acceptedAt,
        completedAt: row.completedAt,
        createdAt: existing?.createdAt ?? row.createdAt,
        updatedAt: row.updatedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          brokerOrderNo: row.brokerOrderNo,
          brokerOrderDate: row.brokerOrderDate,
          filledQty: row.filledQty,
          remainingQty: row.remainingQty,
          averageFillPrice: row.averageFillPrice,
          status: row.status,
          reason: row.reason,
          submittedAt: row.submittedAt,
          acceptedAt: row.acceptedAt,
          completedAt: row.completedAt,
          updatedAt: row.updatedAt,
        },
      });
    return { row: { ...row, id: existing?.id ?? row.id }, inserted: !existing };
  }

  async getOrder(id: string): Promise<OrderRow | undefined> {
    const rows = await this.db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async getOrderByLocalId(accountId: string, localOrderId: string): Promise<OrderRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.orders)
      .where(and(eq(schema.orders.brokerAccountId, accountId), eq(schema.orders.localOrderId, localOrderId)))
      .limit(1);
    return rows[0] ? mapOrder(rows[0]) : undefined;
  }

  async getOrderByBrokerOrderNo(
    accountId: string,
    brokerOrderNo: string,
    brokerOrderDate?: string | null,
  ): Promise<OrderRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.brokerAccountId, accountId));
    return rows
      .map(mapOrder)
      .find(
        (row) =>
          sameOdno(row.brokerOrderNo, brokerOrderNo) &&
          (!brokerOrderDate || row.brokerOrderDate === brokerOrderDate),
      );
  }

  async lastOrderEvent(orderId: string): Promise<OrderEventRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.orderEvents)
      .where(eq(schema.orderEvents.orderId, orderId))
      .orderBy(desc(schema.orderEvents.eventAt), desc(schema.orderEvents.id))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      orderId: row.orderId,
      eventType: row.eventType,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      eventAt: String(row.eventAt),
    };
  }

  async appendOrderEvent(row: OrderEventRow): Promise<void> {
    await this.db.insert(schema.orderEvents).values({
      id: row.id,
      orderId: row.orderId,
      eventType: row.eventType,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      eventAt: row.eventAt,
    });
  }

  async insertExecution(row: ExecutionRow): Promise<{ row: ExecutionRow; inserted: boolean }> {
    const existing = await this.getExecutionByKey(row.brokerAccountId, row.executionKey);
    if (existing) return { row: existing, inserted: false };
    await this.db.insert(schema.executions).values({
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      orderId: row.orderId,
      instrumentId: row.instrumentId,
      tradeId: row.tradeId,
      executionKey: row.executionKey,
      brokerExecutionId: row.brokerExecutionId,
      brokerOrderNo: row.brokerOrderNo,
      side: row.side,
      quantity: row.quantity,
      price: row.price,
      grossAmount: row.grossAmount,
      commission: row.commission,
      tax: row.tax,
      otherFee: row.otherFee,
      realizedPnl: row.realizedPnl,
      currency: row.currency,
      executedAt: row.executedAt,
      createdAt: row.createdAt,
    });
    return { row, inserted: true };
  }

  async getExecutionByKey(accountId: string, executionKey: string): Promise<ExecutionRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.executions)
      .where(and(eq(schema.executions.brokerAccountId, accountId), eq(schema.executions.executionKey, executionKey)))
      .limit(1);
    return rows[0] ? mapExecution(rows[0]) : undefined;
  }

  async findExecutionByBrokerOrderNo(accountId: string, brokerOrderNo: string): Promise<ExecutionRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.brokerAccountId, accountId));
    return rows.map(mapExecution).find((row) => sameOdno(row.brokerOrderNo, brokerOrderNo));
  }

  async listUnlinkedExecutions(accountId: string): Promise<ExecutionRow[]> {
    const rows = await this.db
      .select()
      .from(schema.executions)
      .where(and(eq(schema.executions.brokerAccountId, accountId), sql`${schema.executions.tradeId} is null`))
      .orderBy(schema.executions.executedAt, schema.executions.id);
    return rows.map(mapExecution);
  }

  async linkExecutionTrade(executionId: string, tradeId: string): Promise<void> {
    await this.db.update(schema.executions).set({ tradeId }).where(eq(schema.executions.id, executionId));
  }

  async upsertPosition(row: PositionRow): Promise<PositionRow> {
    await this.db
      .insert(schema.positions)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        instrumentId: row.instrumentId,
        ruleScope: row.ruleScope,
        quantity: row.quantity,
        availableQuantity: row.availableQuantity,
        averagePrice: row.averagePrice,
        totalCost: row.totalCost,
        marketPrice: row.marketPrice,
        marketValue: row.marketValue,
        unrealizedPnl: row.unrealizedPnl,
        unrealizedReturnPct: row.unrealizedReturnPct,
        currency: row.currency,
        provenance: row.provenance,
        updatedAt: row.updatedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          quantity: row.quantity,
          availableQuantity: row.availableQuantity,
          averagePrice: row.averagePrice,
          totalCost: row.totalCost,
          marketPrice: row.marketPrice,
          marketValue: row.marketValue,
          unrealizedPnl: row.unrealizedPnl,
          unrealizedReturnPct: row.unrealizedReturnPct,
          provenance: row.provenance,
          updatedAt: row.updatedAt,
        },
      });
    return row;
  }

  async listPositions(accountId: string): Promise<PositionRow[]> {
    const rows = await this.db.select().from(schema.positions).where(eq(schema.positions.brokerAccountId, accountId));
    return rows.map(mapPosition);
  }

  async getOpenTrade(accountId: string, instrumentId: string, ruleScope: string): Promise<TradeRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.brokerAccountId, accountId),
          eq(schema.trades.instrumentId, instrumentId),
          eq(schema.trades.ruleScope, ruleScope),
          sql`${schema.trades.status} <> 'CLOSED'`,
        ),
      )
      .orderBy(desc(schema.trades.openedAt))
      .limit(1)
      .for("update");
    return rows[0] ? mapTrade(rows[0]) : undefined;
  }

  async upsertTrade(row: TradeRow): Promise<TradeRow> {
    await this.db
      .insert(schema.trades)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        instrumentId: row.instrumentId,
        ruleScope: row.ruleScope,
        source: row.source,
        status: row.status,
        totalBuyQty: row.totalBuyQty,
        totalSellQty: row.totalSellQty,
        totalBuyAmount: row.totalBuyAmount,
        totalSellAmount: row.totalSellAmount,
        averageBuyPrice: row.averageBuyPrice,
        averageSellPrice: row.averageSellPrice,
        totalCommission: row.totalCommission,
        totalTax: row.totalTax,
        totalOtherFee: row.totalOtherFee,
        realizedPnl: row.realizedPnl,
        realizedReturnPct: row.realizedReturnPct,
        currency: row.currency,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: row.status,
          totalBuyQty: row.totalBuyQty,
          totalSellQty: row.totalSellQty,
          totalBuyAmount: row.totalBuyAmount,
          totalSellAmount: row.totalSellAmount,
          averageBuyPrice: row.averageBuyPrice,
          averageSellPrice: row.averageSellPrice,
          totalCommission: row.totalCommission,
          totalTax: row.totalTax,
          totalOtherFee: row.totalOtherFee,
          realizedPnl: row.realizedPnl,
          realizedReturnPct: row.realizedReturnPct,
          closedAt: row.closedAt,
        },
      });
    return row;
  }

  async getTrade(id: string): Promise<TradeRow | undefined> {
    const rows = await this.db.select().from(schema.trades).where(eq(schema.trades.id, id)).limit(1);
    return rows[0] ? mapTrade(rows[0]) : undefined;
  }

  async lastCashSnapshot(accountId: string, currency: string): Promise<CashSnapshotRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.cashBalanceSnapshots)
      .where(
        and(eq(schema.cashBalanceSnapshots.brokerAccountId, accountId), eq(schema.cashBalanceSnapshots.currency, currency)),
      )
      .orderBy(desc(schema.cashBalanceSnapshots.capturedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      currency: row.currency,
      cashBalance: String(row.cashBalance),
      orderableAmount: String(row.orderableAmount),
      withdrawableAmount: row.withdrawableAmount == null ? null : String(row.withdrawableAmount),
      source: row.source,
      capturedAt: String(row.capturedAt),
    };
  }

  async insertCashSnapshot(row: CashSnapshotRow): Promise<void> {
    await this.db.insert(schema.cashBalanceSnapshots).values({
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      currency: row.currency,
      cashBalance: row.cashBalance,
      orderableAmount: row.orderableAmount,
      withdrawableAmount: row.withdrawableAmount,
      source: row.source,
      capturedAt: row.capturedAt,
    });
  }

  async lastAccountSnapshot(accountId: string): Promise<AccountSnapshotRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.accountSnapshots)
      .where(eq(schema.accountSnapshots.brokerAccountId, accountId))
      .orderBy(desc(schema.accountSnapshots.capturedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      baseCurrency: row.baseCurrency,
      totalAssetValue: String(row.totalAssetValue),
      cashValue: String(row.cashValue),
      stockMarketValue: String(row.stockMarketValue),
      realizedPnl: String(row.realizedPnl),
      unrealizedPnl: String(row.unrealizedPnl),
      capturedAt: String(row.capturedAt),
    };
  }

  async insertAccountSnapshot(row: AccountSnapshotRow): Promise<void> {
    await this.db.insert(schema.accountSnapshots).values({
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      baseCurrency: row.baseCurrency,
      totalAssetValue: row.totalAssetValue,
      cashValue: row.cashValue,
      stockMarketValue: row.stockMarketValue,
      realizedPnl: row.realizedPnl,
      unrealizedPnl: row.unrealizedPnl,
      capturedAt: row.capturedAt,
    });
  }

  async insertFxSnapshot(row: FxSnapshotRow): Promise<void> {
    await this.db.insert(schema.fxRateSnapshots).values({
      id: row.id,
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: row.rate,
      source: row.source,
      capturedAt: row.capturedAt,
    });
  }

  async lastReconRun(accountId: string): Promise<ReconRunRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.reconciliationRuns)
      .where(eq(schema.reconciliationRuns.brokerAccountId, accountId))
      .orderBy(desc(schema.reconciliationRuns.startedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      triggerType: row.triggerType,
      status: row.status,
      startedAt: String(row.startedAt),
      finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    };
  }

  async insertReconRun(row: ReconRunRow): Promise<void> {
    await this.db.insert(schema.reconciliationRuns).values({
      id: row.id,
      brokerAccountId: row.brokerAccountId,
      triggerType: row.triggerType,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }

  async insertReconItem(row: ReconItemRow): Promise<void> {
    await this.db.insert(schema.reconciliationItems).values({
      id: row.id,
      reconciliationRunId: row.reconciliationRunId,
      itemType: row.itemType,
      instrumentId: row.instrumentId,
      localReference: row.localReference,
      brokerReference: row.brokerReference,
      localValueJson: row.localValueJson,
      brokerValueJson: row.brokerValueJson,
      status: row.status,
      message: row.message,
    });
  }

  async hasRiskDecision(intentId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: schema.riskDecisions.id })
      .from(schema.riskDecisions)
      .where(eq(schema.riskDecisions.intentId, intentId))
      .limit(1);
    return Boolean(rows[0]);
  }

  async insertRiskDecision(row: RiskDecisionRow): Promise<void> {
    await this.db.insert(schema.riskDecisions).values({
      id: row.id,
      intentId: row.intentId,
      decision: row.decision,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      requestedQty: row.requestedQty,
      requestedAmount: row.requestedAmount,
    });
  }

  async upsertRiskLimits(row: RiskLimitsRow): Promise<void> {
    await this.db
      .insert(schema.riskLimits)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        environment: row.environment,
        maxOrderAmount: row.maxOrderAmount,
        maxOrderQty: row.maxOrderQty,
        maxDailyOrderAmount: row.maxDailyOrderAmount,
        maxDailyOrders: row.maxDailyOrders,
        maxPositionAmount: row.maxPositionAmount,
        maxDailyLoss: row.maxDailyLoss,
        allowTrading: row.allowTrading,
      })
      .onDuplicateKeyUpdate({
        set: {
          maxOrderAmount: row.maxOrderAmount,
          maxOrderQty: row.maxOrderQty,
          maxDailyOrderAmount: row.maxDailyOrderAmount,
          maxDailyOrders: row.maxDailyOrders,
          maxPositionAmount: row.maxPositionAmount,
          maxDailyLoss: row.maxDailyLoss,
          allowTrading: row.allowTrading,
        },
      });
  }

  async getTradingAccountState(accountId: string): Promise<TradingAccountStateRow | undefined> {
    const rows = await this.db
      .select()
      .from(schema.tradingAccountState)
      .where(eq(schema.tradingAccountState.brokerAccountId, accountId))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      brokerAccountId: row.brokerAccountId,
      autoTradingEnabled: Boolean(row.autoTradingEnabled),
      onboardingComplete: Boolean(row.onboardingComplete),
      liquidating: Boolean(row.liquidating),
      circuitHalted: Boolean(row.circuitHalted),
      circuitKind: row.circuitKind,
      circuitReason: row.circuitReason,
      unknownOrderCount: row.unknownOrderCount,
    };
  }

  async upsertTradingAccountState(row: TradingAccountStateRow): Promise<void> {
    await this.db
      .insert(schema.tradingAccountState)
      .values({
        brokerAccountId: row.brokerAccountId,
        autoTradingEnabled: row.autoTradingEnabled,
        onboardingComplete: row.onboardingComplete,
        liquidating: row.liquidating,
        circuitHalted: row.circuitHalted,
        circuitKind: row.circuitKind,
        circuitReason: row.circuitReason,
        unknownOrderCount: row.unknownOrderCount,
      })
      .onDuplicateKeyUpdate({
        set: {
          autoTradingEnabled: row.autoTradingEnabled,
          onboardingComplete: row.onboardingComplete,
          liquidating: row.liquidating,
          circuitHalted: row.circuitHalted,
          circuitKind: row.circuitKind,
          circuitReason: row.circuitReason,
          unknownOrderCount: row.unknownOrderCount,
        },
      });
  }

  async upsertTradingRule(row: TradingRuleRow): Promise<void> {
    await this.db
      .insert(schema.tradingRules)
      .values({
        id: row.id,
        userId: row.userId,
        brokerAccountId: row.brokerAccountId,
        ruleKey: row.ruleKey,
        instrumentId: row.instrumentId,
        name: row.name,
        kind: row.kind,
        intervalMs: row.intervalMs,
        fastMa: row.fastMa,
        slowMa: row.slowMa,
        buyPct: row.buyPct,
        sliceAmount: row.sliceAmount,
        minAmount: row.minAmount,
        stopLossPct: row.stopLossPct,
        takeProfitPct: row.takeProfitPct,
        budget: row.budget,
        enabled: row.enabled,
        configJson: row.configJson,
      })
      .onDuplicateKeyUpdate({
        set: {
          name: row.name,
          kind: row.kind,
          intervalMs: row.intervalMs,
          enabled: row.enabled,
          budget: row.budget,
          configJson: row.configJson,
        },
      });
  }

  async upsertRuleAllocation(row: RuleAllocationRow): Promise<void> {
    await this.db
      .insert(schema.ruleAllocations)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        ruleKey: row.ruleKey,
        budget: row.budget,
        balance: row.balance,
        enabled: row.enabled,
        lastRunAt: row.lastRunAt,
        lastMessage: row.lastMessage,
        metaJson: row.metaJson,
      })
      .onDuplicateKeyUpdate({
        set: {
          budget: row.budget,
          balance: row.balance,
          enabled: row.enabled,
          lastRunAt: row.lastRunAt,
          lastMessage: row.lastMessage,
          metaJson: row.metaJson,
        },
      });
  }

  async upsertAutoCondition(row: AutoConditionRow): Promise<void> {
    await this.db
      .insert(schema.autoConditions)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        conditionKey: row.conditionKey,
        instrumentId: row.instrumentId,
        status: row.status,
        configJson: row.configJson,
      })
      .onDuplicateKeyUpdate({
        set: { status: row.status, configJson: row.configJson, instrumentId: row.instrumentId },
      });
  }

  async upsertDcaPlan(row: DcaPlanRow): Promise<void> {
    await this.db
      .insert(schema.dcaPlans)
      .values({
        id: row.id,
        brokerAccountId: row.brokerAccountId,
        planKey: row.planKey,
        instrumentId: row.instrumentId,
        status: row.status,
        configJson: row.configJson,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
      })
      .onDuplicateKeyUpdate({
        set: { status: row.status, configJson: row.configJson, nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt },
      });
  }

  async insertAudit(row: AuditLogRow): Promise<void> {
    await this.db.insert(schema.auditLogs).values({
      id: row.id,
      userId: row.userId,
      brokerAccountId: row.brokerAccountId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeDataJson: row.beforeDataJson,
      afterDataJson: row.afterDataJson,
    });
  }

  async insertMigrationRun(row: MigrationRunRow): Promise<void> {
    await this.db.insert(schema.migrationRuns).values({
      id: row.id,
      migrationType: row.migrationType,
      sourcePath: row.sourcePath,
      status: row.status,
      importedOrders: row.importedOrders,
      importedIntents: row.importedIntents,
      importedPositions: row.importedPositions,
      importedRules: row.importedRules,
      warningsJson: row.warningsJson,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  }

  async listBuyHistory(filter: HistoryFilter): Promise<Page<BuyHistoryRow>> {
    const limit = clampLimit(filter.limit);
    const rows = await this.db.select().from(schema.vBuyHistory).orderBy(desc(schema.vBuyHistory.executedAt)).limit(500);
    const mapped: BuyHistoryRow[] = rows
      .map((row) => ({
        executionId: row.executionId,
        brokerAccountId: row.brokerAccountId,
        userId: row.userId,
        orderId: row.orderId,
        instrumentId: row.instrumentId,
        country: row.country,
        market: row.market,
        symbol: row.symbol,
        displayName: row.displayName,
        quantity: String(row.quantity),
        price: String(row.price),
        grossAmount: String(row.grossAmount),
        commission: String(row.commission),
        tax: String(row.tax),
        otherFee: String(row.otherFee),
        currency: row.currency,
        brokerOrderNo: row.brokerOrderNo,
        executedAt: String(row.executedAt),
      }))
      .filter((row) => !filter.account || row.brokerAccountId === filter.account)
      .filter((row) => !filter.country || row.country === filter.country.toUpperCase())
      .filter((row) => !filter.market || row.market === filter.market.toUpperCase())
      .filter((row) => !filter.symbol || row.symbol === filter.symbol.toUpperCase())
      .filter((row) => !filter.from || row.executedAt >= filter.from)
      .filter((row) => !filter.to || row.executedAt <= filter.to);
    const cursor = decodeCursor(filter.cursor);
    const after = cursor
      ? mapped.filter((row) => row.executedAt < cursor.at || (row.executedAt === cursor.at && row.executionId < cursor.id))
      : mapped;
    const items = after.slice(0, limit);
    const extra = after[limit];
    return {
      items,
      nextCursor: extra ? encodeCursor(items[items.length - 1]!.executedAt, items[items.length - 1]!.executionId) : null,
      limit,
    };
  }

  async listTrades(filter: HistoryFilter): Promise<Page<TradeRow & { symbol?: string; name?: string; market?: string }>> {
    const limit = clampLimit(filter.limit);
    const rows = await this.db
      .select({
        trade: schema.trades,
        symbol: schema.instruments.symbol,
        name: schema.instruments.displayName,
        market: schema.instruments.market,
        country: schema.instruments.country,
      })
      .from(schema.trades)
      .innerJoin(schema.instruments, eq(schema.trades.instrumentId, schema.instruments.id))
      .orderBy(desc(schema.trades.openedAt));
    const mapped = rows
      .map((row) => ({ ...mapTrade(row.trade), symbol: row.symbol, name: row.name, market: row.market, country: row.country }))
      .filter((row) => !filter.account || row.brokerAccountId === filter.account)
      .filter((row) => !filter.status || row.status === filter.status.toUpperCase())
      .filter((row) => !filter.rule || row.ruleScope === filter.rule)
      .filter((row) => !filter.symbol || row.symbol === filter.symbol.toUpperCase())
      .filter((row) => !filter.market || row.market === filter.market.toUpperCase())
      .filter((row) => !filter.country || row.country === filter.country.toUpperCase())
      .filter((row) => !filter.from || row.openedAt >= filter.from)
      .filter((row) => !filter.to || row.openedAt <= filter.to);
    const cursor = decodeCursor(filter.cursor);
    const after = cursor
      ? mapped.filter((row) => row.openedAt < cursor.at || (row.openedAt === cursor.at && row.id < cursor.id))
      : mapped;
    const items = after.slice(0, limit);
    return {
      items,
      nextCursor: after[limit] ? encodeCursor(items[items.length - 1]!.openedAt, items[items.length - 1]!.id) : null,
      limit,
    };
  }

  async listCurrentPositions(
    filter: HistoryFilter,
  ): Promise<Page<PositionRow & { symbol?: string; name?: string; market?: string }>> {
    const limit = clampLimit(filter.limit);
    const rows = await this.db
      .select({
        position: schema.positions,
        symbol: schema.instruments.symbol,
        name: schema.instruments.displayName,
        market: schema.instruments.market,
      })
      .from(schema.positions)
      .innerJoin(schema.instruments, eq(schema.positions.instrumentId, schema.instruments.id));
    const mapped = rows
      .map((row) => ({ ...mapPosition(row.position), symbol: row.symbol, name: row.name, market: row.market }))
      .filter((row) => moneyNumber(row.quantity) > 0)
      .filter((row) => !filter.account || row.brokerAccountId === filter.account)
      .filter((row) => !filter.rule || row.ruleScope === filter.rule)
      .filter((row) => !filter.symbol || row.symbol === filter.symbol.toUpperCase());
    const items = mapped.slice(0, limit);
    return { items, nextCursor: mapped[limit] ? encodeCursor("", items[items.length - 1]!.id) : null, limit };
  }

  async listExecutionsForTrade(tradeId: string): Promise<ExecutionRow[]> {
    const rows = await this.db
      .select()
      .from(schema.executions)
      .where(eq(schema.executions.tradeId, tradeId))
      .orderBy(schema.executions.executedAt);
    return rows.map(mapExecution);
  }

  async counts() {
    return {
      users: 0,
      brokerAccounts: 0,
      instruments: 0,
      intents: 0,
      orders: 0,
      orderEvents: 0,
      executions: 0,
      positions: 0,
      trades: 0,
      buyHistory: 0,
      reconRuns: 0,
      reconItems: 0,
      cashSnapshots: 0,
      accountSnapshots: 0,
      audits: 0,
      migrationRuns: 0,
    };
  }
}

function mapOrder(row: typeof schema.orders.$inferSelect): OrderRow {
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    instrumentId: row.instrumentId,
    intentId: row.intentId,
    localOrderId: row.localOrderId,
    brokerOrderNo: row.brokerOrderNo,
    brokerOrderDate: row.brokerOrderDate,
    brokerOrgNo: row.brokerOrgNo,
    side: row.side,
    orderType: row.orderType,
    requestedQty: String(row.requestedQty),
    requestedPrice: row.requestedPrice == null ? null : String(row.requestedPrice),
    filledQty: String(row.filledQty),
    remainingQty: String(row.remainingQty),
    averageFillPrice: row.averageFillPrice == null ? null : String(row.averageFillPrice),
    currency: row.currency,
    status: row.status,
    source: row.source,
    sourceId: row.sourceId,
    ruleKey: row.ruleKey,
    reason: row.reason,
    submittedAt: row.submittedAt == null ? null : String(row.submittedAt),
    acceptedAt: row.acceptedAt == null ? null : String(row.acceptedAt),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function mapExecution(row: typeof schema.executions.$inferSelect): ExecutionRow {
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    orderId: row.orderId,
    instrumentId: row.instrumentId,
    tradeId: row.tradeId,
    executionKey: row.executionKey,
    brokerExecutionId: row.brokerExecutionId,
    brokerOrderNo: row.brokerOrderNo,
    side: row.side,
    quantity: String(row.quantity),
    price: String(row.price),
    grossAmount: String(row.grossAmount),
    commission: String(row.commission),
    tax: String(row.tax),
    otherFee: String(row.otherFee),
    realizedPnl: row.realizedPnl == null ? null : String(row.realizedPnl),
    currency: row.currency,
    executedAt: String(row.executedAt),
    createdAt: String(row.createdAt),
  };
}

function mapPosition(row: typeof schema.positions.$inferSelect): PositionRow {
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    instrumentId: row.instrumentId,
    ruleScope: row.ruleScope,
    quantity: String(row.quantity),
    availableQuantity: String(row.availableQuantity),
    averagePrice: String(row.averagePrice),
    totalCost: String(row.totalCost),
    marketPrice: row.marketPrice == null ? null : String(row.marketPrice),
    marketValue: row.marketValue == null ? null : String(row.marketValue),
    unrealizedPnl: row.unrealizedPnl == null ? null : String(row.unrealizedPnl),
    unrealizedReturnPct: row.unrealizedReturnPct == null ? null : String(row.unrealizedReturnPct),
    currency: row.currency,
    provenance: row.provenance,
    updatedAt: String(row.updatedAt),
  };
}

function mapTrade(row: typeof schema.trades.$inferSelect): TradeRow {
  return {
    id: row.id,
    brokerAccountId: row.brokerAccountId,
    instrumentId: row.instrumentId,
    ruleScope: row.ruleScope,
    source: row.source,
    status: row.status,
    totalBuyQty: String(row.totalBuyQty),
    totalSellQty: String(row.totalSellQty),
    totalBuyAmount: String(row.totalBuyAmount),
    totalSellAmount: String(row.totalSellAmount),
    averageBuyPrice: row.averageBuyPrice == null ? null : String(row.averageBuyPrice),
    averageSellPrice: row.averageSellPrice == null ? null : String(row.averageSellPrice),
    totalCommission: String(row.totalCommission),
    totalTax: String(row.totalTax),
    totalOtherFee: String(row.totalOtherFee),
    realizedPnl: String(row.realizedPnl),
    realizedReturnPct: row.realizedReturnPct == null ? null : String(row.realizedReturnPct),
    currency: row.currency,
    openedAt: String(row.openedAt),
    closedAt: row.closedAt == null ? null : String(row.closedAt),
  };
}

export class MysqlLedger implements Ledger {
  constructor(private readonly db: AppDb) {}

  async transaction<T>(fn: (tx: LedgerSession) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const session = new MysqlSession(tx as unknown as AppDb);
      return fn(session);
    });
  }
}

let singleton: MysqlLedger | null = null;

export function getMysqlLedger(env: EnvMap = process.env): MysqlLedger {
  if (singleton) return singleton;
  const db = getDb(env);
  if (!db) throw new Error("DATABASE_URL missing");
  singleton = new MysqlLedger(db);
  return singleton;
}

export function resetMysqlLedgerForTest(): void {
  singleton = null;
}
