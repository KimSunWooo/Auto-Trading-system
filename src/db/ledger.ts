import { newId } from "@/src/db/ids";
import { moneyNumber } from "@/src/db/money";
import { sameOdno } from "@/src/brokers/kis-client";
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

export type LedgerSession = {
  upsertUser(row: UserRow): Promise<UserRow>;
  upsertBrokerAccount(row: BrokerAccountRow): Promise<BrokerAccountRow>;
  upsertCredentialRef(accountId: string, secretRef: string): Promise<void>;
  upsertInstrument(row: InstrumentRow): Promise<InstrumentRow>;
  getInstrument(id: string): Promise<InstrumentRow | undefined>;
  upsertIntent(row: IntentRow): Promise<{ row: IntentRow; inserted: boolean }>;
  getIntentByKey(accountId: string, intentKey: string): Promise<IntentRow | undefined>;
  upsertOrder(row: OrderRow): Promise<{ row: OrderRow; inserted: boolean }>;
  getOrder(id: string): Promise<OrderRow | undefined>;
  getOrderByLocalId(accountId: string, localOrderId: string): Promise<OrderRow | undefined>;
  getOrderByBrokerOrderNo(
    accountId: string,
    brokerOrderNo: string,
    brokerOrderDate?: string | null,
  ): Promise<OrderRow | undefined>;
  lastOrderEvent(orderId: string): Promise<OrderEventRow | undefined>;
  appendOrderEvent(row: OrderEventRow): Promise<void>;
  insertExecution(row: ExecutionRow): Promise<{ row: ExecutionRow; inserted: boolean }>;
  getExecutionByKey(accountId: string, executionKey: string): Promise<ExecutionRow | undefined>;
  findExecutionByBrokerOrderNo(accountId: string, brokerOrderNo: string): Promise<ExecutionRow | undefined>;
  listUnlinkedExecutions(accountId: string): Promise<ExecutionRow[]>;
  linkExecutionTrade(executionId: string, tradeId: string): Promise<void>;
  upsertPosition(row: PositionRow): Promise<PositionRow>;
  listPositions(accountId: string): Promise<PositionRow[]>;
  getOpenTrade(accountId: string, instrumentId: string, ruleScope: string): Promise<TradeRow | undefined>;
  upsertTrade(row: TradeRow): Promise<TradeRow>;
  getTrade(id: string): Promise<TradeRow | undefined>;
  lastCashSnapshot(accountId: string, currency: string): Promise<CashSnapshotRow | undefined>;
  insertCashSnapshot(row: CashSnapshotRow): Promise<void>;
  lastAccountSnapshot(accountId: string): Promise<AccountSnapshotRow | undefined>;
  insertAccountSnapshot(row: AccountSnapshotRow): Promise<void>;
  insertFxSnapshot(row: FxSnapshotRow): Promise<void>;
  lastReconRun(accountId: string): Promise<ReconRunRow | undefined>;
  insertReconRun(row: ReconRunRow): Promise<void>;
  insertReconItem(row: ReconItemRow): Promise<void>;
  hasRiskDecision(intentId: string): Promise<boolean>;
  insertRiskDecision(row: RiskDecisionRow): Promise<void>;
  upsertRiskLimits(row: RiskLimitsRow): Promise<void>;
  getTradingAccountState(accountId: string): Promise<TradingAccountStateRow | undefined>;
  upsertTradingAccountState(row: TradingAccountStateRow): Promise<void>;
  upsertTradingRule(row: TradingRuleRow): Promise<void>;
  upsertRuleAllocation(row: RuleAllocationRow): Promise<void>;
  upsertAutoCondition(row: AutoConditionRow): Promise<void>;
  upsertDcaPlan(row: DcaPlanRow): Promise<void>;
  insertAudit(row: AuditLogRow): Promise<void>;
  insertMigrationRun(row: MigrationRunRow): Promise<void>;
  listBrokerAccounts(): Promise<BrokerAccountRow[]>;
  getUser(id: string): Promise<UserRow | undefined>;
  listBuyHistory(filter: HistoryFilter): Promise<Page<BuyHistoryRow>>;
  listTrades(filter: HistoryFilter): Promise<Page<TradeRow & { symbol?: string; name?: string; market?: string }>>;
  listCurrentPositions(filter: HistoryFilter): Promise<Page<PositionRow & { symbol?: string; name?: string; market?: string }>>;
  listExecutionsForTrade(tradeId: string): Promise<ExecutionRow[]>;
  counts(): Promise<{
    users: number;
    brokerAccounts: number;
    instruments: number;
    intents: number;
    orders: number;
    orderEvents: number;
    executions: number;
    positions: number;
    trades: number;
    buyHistory: number;
    reconRuns: number;
    reconItems: number;
    cashSnapshots: number;
    accountSnapshots: number;
    audits: number;
    migrationRuns: number;
  }>;
};

export type Ledger = {
  transaction<T>(fn: (tx: LedgerSession) => Promise<T>): Promise<T>;
};

export type MemoryState = {
  users: Map<string, UserRow>;
  brokerAccounts: Map<string, BrokerAccountRow>;
  credentialRefs: Map<string, string>;
  instruments: Map<string, InstrumentRow>;
  intents: Map<string, IntentRow>;
  orders: Map<string, OrderRow>;
  orderEvents: OrderEventRow[];
  executions: Map<string, ExecutionRow>;
  positions: Map<string, PositionRow>;
  trades: Map<string, TradeRow>;
  cash: CashSnapshotRow[];
  accounts: AccountSnapshotRow[];
  fx: FxSnapshotRow[];
  reconRuns: ReconRunRow[];
  reconItems: ReconItemRow[];
  riskDecisions: RiskDecisionRow[];
  riskLimits: Map<string, RiskLimitsRow>;
  tradingState: Map<string, TradingAccountStateRow>;
  tradingRules: Map<string, TradingRuleRow>;
  allocations: Map<string, RuleAllocationRow>;
  conditions: Map<string, AutoConditionRow>;
  dca: Map<string, DcaPlanRow>;
  audits: AuditLogRow[];
  migrations: MigrationRunRow[];
};

function emptyState(): MemoryState {
  return {
    users: new Map(),
    brokerAccounts: new Map(),
    credentialRefs: new Map(),
    instruments: new Map(),
    intents: new Map(),
    orders: new Map(),
    orderEvents: [],
    executions: new Map(),
    positions: new Map(),
    trades: new Map(),
    cash: [],
    accounts: [],
    fx: [],
    reconRuns: [],
    reconItems: [],
    riskDecisions: [],
    riskLimits: new Map(),
    tradingState: new Map(),
    tradingRules: new Map(),
    allocations: new Map(),
    conditions: new Map(),
    dca: new Map(),
    audits: [],
    migrations: [],
  };
}

function cloneState(state: MemoryState): MemoryState {
  return structuredClone(state);
}

function clampLimit(limit?: number): number {
  const n = Number(limit ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf("|");
    if (idx < 0) return null;
    return { at: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

function afterCursor<T>(
  rows: T[],
  cursor: { at: string; id: string } | null,
  atOf: (row: T) => string,
  idOf: (row: T) => string,
): T[] {
  if (!cursor) return rows;
  return rows.filter((row) => {
    const at = atOf(row);
    const id = idOf(row);
    return at < cursor.at || (at === cursor.at && id < cursor.id);
  });
}

function matchesRange(value: string, from?: string, to?: string): boolean {
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

export class MemoryLedger implements Ledger {
  snapshot: MemoryState = emptyState();

  async transaction<T>(fn: (tx: LedgerSession) => Promise<T>): Promise<T> {
    const working = cloneState(this.snapshot);
    const session = new MemorySession(working);
    try {
      const result = await fn(session);
      this.snapshot = working;
      return result;
    } catch (err) {
      throw err;
    }
  }
}

export class MemorySession implements LedgerSession {
  constructor(readonly state: MemoryState) {}

  async upsertUser(row: UserRow): Promise<UserRow> {
    const byEmail = [...this.state.users.values()].find((u) => u.email && u.email === row.email);
    const current = byEmail ?? this.state.users.get(row.id);
    const next = { ...(current ?? row), ...row, id: current?.id ?? row.id };
    this.state.users.set(next.id, next);
    return next;
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    return this.state.users.get(id);
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
    const existing = this.state.brokerAccounts.get(row.id);
    if (!existing) {
      const inserted: BrokerAccountRow = {
        ...row,
        physicalAccountFingerprint:
          row.physicalAccountFingerprint === undefined ? null : row.physicalAccountFingerprint,
      };
      this.state.brokerAccounts.set(inserted.id, inserted);
      return inserted;
    }
    const next: BrokerAccountRow = {
      ...existing,
      displayName: row.displayName,
      accountNumberMasked: row.accountNumberMasked,
      isDefault: row.isDefault,
      credentialRef: row.credentialRef,
      // Do not force ACTIVE over DISABLED (mirror must not reactivate released bootstrap).
      status: row.status === "DISABLED" ? "DISABLED" : existing.status,
    };
    if (row.physicalAccountFingerprint !== undefined) {
      next.physicalAccountFingerprint = row.physicalAccountFingerprint;
    }
    this.state.brokerAccounts.set(next.id, next);
    return next;
  }

  async listBrokerAccounts(): Promise<BrokerAccountRow[]> {
    return [...this.state.brokerAccounts.values()];
  }

  async upsertCredentialRef(accountId: string, secretRef: string): Promise<void> {
    this.state.credentialRefs.set(accountId, secretRef);
  }

  async upsertInstrument(row: InstrumentRow): Promise<InstrumentRow> {
    const byIdentity = [...this.state.instruments.values()].find(
      (item) => item.country === row.country && item.market === row.market && item.symbol === row.symbol,
    );
    const current = byIdentity ?? this.state.instruments.get(row.id);
    const next = { ...(current ?? row), ...row, id: current?.id ?? row.id };
    this.state.instruments.set(next.id, next);
    return next;
  }

  async getInstrument(id: string): Promise<InstrumentRow | undefined> {
    return this.state.instruments.get(id);
  }

  async upsertIntent(row: IntentRow): Promise<{ row: IntentRow; inserted: boolean }> {
    const existing = [...this.state.intents.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.intentKey === row.intentKey,
    );
    if (existing) {
      const next = { ...existing, ...row, id: existing.id, createdAt: existing.createdAt };
      this.state.intents.set(existing.id, next);
      return { row: next, inserted: false };
    }
    this.state.intents.set(row.id, row);
    return { row, inserted: true };
  }

  async getIntentByKey(accountId: string, intentKey: string): Promise<IntentRow | undefined> {
    return [...this.state.intents.values()].find(
      (item) => item.brokerAccountId === accountId && item.intentKey === intentKey,
    );
  }

  async upsertOrder(row: OrderRow): Promise<{ row: OrderRow; inserted: boolean }> {
    const byLocal = [...this.state.orders.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.localOrderId === row.localOrderId,
    );
    const byBroker =
      row.brokerOrderNo && row.brokerOrderDate
        ? [...this.state.orders.values()].find(
            (item) =>
              item.brokerAccountId === row.brokerAccountId &&
              item.brokerOrderDate === row.brokerOrderDate &&
              item.brokerOrderNo === row.brokerOrderNo,
          )
        : undefined;
    const existing = byLocal ?? byBroker;
    if (existing) {
      const next = { ...existing, ...row, id: existing.id, createdAt: existing.createdAt };
      this.state.orders.set(existing.id, next);
      return { row: next, inserted: false };
    }
    this.state.orders.set(row.id, row);
    return { row, inserted: true };
  }

  async getOrder(id: string): Promise<OrderRow | undefined> {
    return this.state.orders.get(id);
  }

  async getOrderByLocalId(accountId: string, localOrderId: string): Promise<OrderRow | undefined> {
    return [...this.state.orders.values()].find(
      (item) => item.brokerAccountId === accountId && item.localOrderId === localOrderId,
    );
  }

  async getOrderByBrokerOrderNo(
    accountId: string,
    brokerOrderNo: string,
    brokerOrderDate?: string | null,
  ): Promise<OrderRow | undefined> {
    return [...this.state.orders.values()].find(
      (item) =>
        item.brokerAccountId === accountId &&
        sameOdno(item.brokerOrderNo, brokerOrderNo) &&
        (!brokerOrderDate || item.brokerOrderDate === brokerOrderDate),
    );
  }

  async lastOrderEvent(orderId: string): Promise<OrderEventRow | undefined> {
    return [...this.state.orderEvents].reverse().find((row) => row.orderId === orderId);
  }

  async appendOrderEvent(row: OrderEventRow): Promise<void> {
    this.state.orderEvents.push(row);
  }

  async insertExecution(row: ExecutionRow): Promise<{ row: ExecutionRow; inserted: boolean }> {
    const existing = [...this.state.executions.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.executionKey === row.executionKey,
    );
    if (existing) return { row: existing, inserted: false };
    this.state.executions.set(row.id, row);
    return { row, inserted: true };
  }

  async getExecutionByKey(accountId: string, executionKey: string): Promise<ExecutionRow | undefined> {
    return [...this.state.executions.values()].find(
      (item) => item.brokerAccountId === accountId && item.executionKey === executionKey,
    );
  }

  async findExecutionByBrokerOrderNo(accountId: string, brokerOrderNo: string): Promise<ExecutionRow | undefined> {
    return [...this.state.executions.values()].find(
      (item) => item.brokerAccountId === accountId && sameOdno(item.brokerOrderNo, brokerOrderNo),
    );
  }

  async listUnlinkedExecutions(accountId: string): Promise<ExecutionRow[]> {
    return [...this.state.executions.values()]
      .filter((row) => row.brokerAccountId === accountId && !row.tradeId)
      .sort((a, b) => {
        if (a.executedAt !== b.executedAt) return a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0;
        if (a.side !== b.side) return a.side === "BUY" ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
  }

  async linkExecutionTrade(executionId: string, tradeId: string): Promise<void> {
    const row = this.state.executions.get(executionId);
    if (row) this.state.executions.set(executionId, { ...row, tradeId });
  }

  async upsertPosition(row: PositionRow): Promise<PositionRow> {
    const existing = [...this.state.positions.values()].find(
      (item) =>
        item.brokerAccountId === row.brokerAccountId &&
        item.instrumentId === row.instrumentId &&
        item.ruleScope === row.ruleScope,
    );
    const next = { ...(existing ?? row), ...row, id: existing?.id ?? row.id };
    this.state.positions.set(next.id, next);
    return next;
  }

  async listPositions(accountId: string): Promise<PositionRow[]> {
    return [...this.state.positions.values()].filter((row) => row.brokerAccountId === accountId);
  }

  async getOpenTrade(accountId: string, instrumentId: string, ruleScope: string): Promise<TradeRow | undefined> {
    return [...this.state.trades.values()]
      .filter(
        (row) =>
          row.brokerAccountId === accountId &&
          row.instrumentId === instrumentId &&
          row.ruleScope === ruleScope &&
          row.status !== "CLOSED",
      )
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1))[0];
  }

  async upsertTrade(row: TradeRow): Promise<TradeRow> {
    const existing = this.state.trades.get(row.id);
    const next = { ...(existing ?? row), ...row };
    this.state.trades.set(next.id, next);
    return next;
  }

  async getTrade(id: string): Promise<TradeRow | undefined> {
    return this.state.trades.get(id);
  }

  async lastCashSnapshot(accountId: string, currency: string): Promise<CashSnapshotRow | undefined> {
    return [...this.state.cash]
      .filter((row) => row.brokerAccountId === accountId && row.currency === currency)
      .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0];
  }

  async insertCashSnapshot(row: CashSnapshotRow): Promise<void> {
    this.state.cash.push(row);
  }

  async lastAccountSnapshot(accountId: string): Promise<AccountSnapshotRow | undefined> {
    return [...this.state.accounts]
      .filter((row) => row.brokerAccountId === accountId)
      .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0];
  }

  async insertAccountSnapshot(row: AccountSnapshotRow): Promise<void> {
    this.state.accounts.push(row);
  }

  async insertFxSnapshot(row: FxSnapshotRow): Promise<void> {
    this.state.fx.push(row);
  }

  async lastReconRun(accountId: string): Promise<ReconRunRow | undefined> {
    return [...this.state.reconRuns]
      .filter((row) => row.brokerAccountId === accountId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  }

  async insertReconRun(row: ReconRunRow): Promise<void> {
    this.state.reconRuns.push(row);
  }

  async insertReconItem(row: ReconItemRow): Promise<void> {
    this.state.reconItems.push(row);
  }

  async hasRiskDecision(intentId: string): Promise<boolean> {
    return this.state.riskDecisions.some((row) => row.intentId === intentId);
  }

  async insertRiskDecision(row: RiskDecisionRow): Promise<void> {
    if (this.state.riskDecisions.some((item) => item.intentId === row.intentId && item.decision === row.decision)) {
      return;
    }
    this.state.riskDecisions.push(row);
  }

  async upsertRiskLimits(row: RiskLimitsRow): Promise<void> {
    const key = `${row.brokerAccountId}:${row.environment}`;
    const existing = this.state.riskLimits.get(key);
    this.state.riskLimits.set(key, { ...(existing ?? row), ...row, id: existing?.id ?? row.id });
  }

  async getTradingAccountState(accountId: string): Promise<TradingAccountStateRow | undefined> {
    return this.state.tradingState.get(accountId);
  }

  async upsertTradingAccountState(row: TradingAccountStateRow): Promise<void> {
    this.state.tradingState.set(row.brokerAccountId, row);
  }

  async upsertTradingRule(row: TradingRuleRow): Promise<void> {
    const existing = [...this.state.tradingRules.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.ruleKey === row.ruleKey,
    );
    const next = { ...(existing ?? row), ...row, id: existing?.id ?? row.id };
    this.state.tradingRules.set(next.id, next);
  }

  async upsertRuleAllocation(row: RuleAllocationRow): Promise<void> {
    const existing = [...this.state.allocations.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.ruleKey === row.ruleKey,
    );
    const next = { ...(existing ?? row), ...row, id: existing?.id ?? row.id };
    this.state.allocations.set(next.id, next);
  }

  async upsertAutoCondition(row: AutoConditionRow): Promise<void> {
    const existing = [...this.state.conditions.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.conditionKey === row.conditionKey,
    );
    const next = { ...(existing ?? row), ...row, id: existing?.id ?? row.id };
    this.state.conditions.set(next.id, next);
  }

  async upsertDcaPlan(row: DcaPlanRow): Promise<void> {
    const existing = [...this.state.dca.values()].find(
      (item) => item.brokerAccountId === row.brokerAccountId && item.planKey === row.planKey,
    );
    const next = { ...(existing ?? row), ...row, id: existing?.id ?? row.id };
    this.state.dca.set(next.id, next);
  }

  async insertAudit(row: AuditLogRow): Promise<void> {
    this.state.audits.push(row);
  }

  async insertMigrationRun(row: MigrationRunRow): Promise<void> {
    this.state.migrations.push(row);
  }

  private resolveAccountIds(filter: HistoryFilter): Set<string> | null {
    if (!filter.account) return null;
    const raw = filter.account.trim().toUpperCase();
    const ids = [...this.state.brokerAccounts.values()]
      .filter((row) => row.id === filter.account || row.environment === raw)
      .map((row) => row.id);
    return new Set(ids.length ? ids : [filter.account]);
  }

  async listBuyHistory(filter: HistoryFilter): Promise<Page<BuyHistoryRow>> {
    const limit = clampLimit(filter.limit);
    const accountIds = this.resolveAccountIds(filter);
    const cursor = decodeCursor(filter.cursor);
    const rows: BuyHistoryRow[] = [...this.state.executions.values()]
      .filter((row) => row.side === "BUY")
      .filter((row) => !accountIds || accountIds.has(row.brokerAccountId))
      .map((row) => {
        const instrument = this.state.instruments.get(row.instrumentId);
        const account = this.state.brokerAccounts.get(row.brokerAccountId);
        return {
          executionId: row.id,
          brokerAccountId: row.brokerAccountId,
          userId: account?.userId ?? "",
          orderId: row.orderId,
          instrumentId: row.instrumentId,
          country: instrument?.country ?? "",
          market: instrument?.market ?? "",
          symbol: instrument?.symbol ?? "",
          displayName: instrument?.displayName ?? "",
          quantity: row.quantity,
          price: row.price,
          grossAmount: row.grossAmount,
          commission: row.commission,
          tax: row.tax,
          otherFee: row.otherFee,
          currency: row.currency,
          brokerOrderNo: row.brokerOrderNo,
          executedAt: row.executedAt,
        };
      })
      .filter((row) => (!filter.country || row.country === filter.country.toUpperCase()))
      .filter((row) => (!filter.market || row.market === filter.market.toUpperCase()))
      .filter((row) => (!filter.symbol || row.symbol === filter.symbol.toUpperCase()))
      .filter((row) => matchesRange(row.executedAt, filter.from, filter.to))
      .sort((a, b) => (a.executedAt === b.executedAt ? b.executionId.localeCompare(a.executionId) : a.executedAt < b.executedAt ? 1 : -1));
    const sliced = afterCursor(rows, cursor, (row) => row.executedAt, (row) => row.executionId).slice(0, limit + 1);
    const items = sliced.slice(0, limit);
    const extra = sliced[limit];
    return {
      items,
      nextCursor: extra ? encodeCursor(items[items.length - 1]!.executedAt, items[items.length - 1]!.executionId) : null,
      limit,
    };
  }

  async listTrades(
    filter: HistoryFilter,
  ): Promise<Page<TradeRow & { symbol?: string; name?: string; market?: string }>> {
    const limit = clampLimit(filter.limit);
    const accountIds = this.resolveAccountIds(filter);
    const cursor = decodeCursor(filter.cursor);
    const rows = [...this.state.trades.values()]
      .filter((row) => !accountIds || accountIds.has(row.brokerAccountId))
      .filter((row) => !filter.status || row.status === filter.status.toUpperCase())
      .filter((row) => !filter.rule || row.ruleScope === filter.rule)
      .map((row) => {
        const instrument = this.state.instruments.get(row.instrumentId);
        return {
          ...row,
          symbol: instrument?.symbol,
          name: instrument?.displayName,
          market: instrument?.market,
        };
      })
      .filter((row) => !filter.symbol || row.symbol === filter.symbol.toUpperCase())
      .filter((row) => !filter.market || row.market === filter.market.toUpperCase())
      .filter((row) => !filter.country || this.state.instruments.get(row.instrumentId)?.country === filter.country.toUpperCase())
      .filter((row) => matchesRange(row.openedAt, filter.from, filter.to))
      .sort((a, b) => (a.openedAt === b.openedAt ? b.id.localeCompare(a.id) : a.openedAt < b.openedAt ? 1 : -1));
    const sliced = afterCursor(rows, cursor, (row) => row.openedAt, (row) => row.id).slice(0, limit + 1);
    const items = sliced.slice(0, limit);
    return {
      items,
      nextCursor: sliced[limit] ? encodeCursor(items[items.length - 1]!.openedAt, items[items.length - 1]!.id) : null,
      limit,
    };
  }

  async listCurrentPositions(
    filter: HistoryFilter,
  ): Promise<Page<PositionRow & { symbol?: string; name?: string; market?: string }>> {
    const limit = clampLimit(filter.limit);
    const accountIds = this.resolveAccountIds(filter);
    const cursor = decodeCursor(filter.cursor);
    const rows = [...this.state.positions.values()]
      .filter((row) => moneyNumber(row.quantity) > 0)
      .filter((row) => !accountIds || accountIds.has(row.brokerAccountId))
      .filter((row) => !filter.rule || row.ruleScope === filter.rule)
      .map((row) => {
        const instrument = this.state.instruments.get(row.instrumentId);
        return { ...row, symbol: instrument?.symbol, name: instrument?.displayName, market: instrument?.market };
      })
      .filter((row) => !filter.symbol || row.symbol === filter.symbol.toUpperCase())
      .filter((row) => !filter.market || row.market === filter.market.toUpperCase())
      .sort((a, b) => a.id.localeCompare(b.id));
    const sliced = afterCursor(rows, cursor, () => "", (row) => row.id).slice(0, limit + 1);
    const items = sliced.slice(0, limit);
    return {
      items,
      nextCursor: sliced[limit] ? encodeCursor("", items[items.length - 1]!.id) : null,
      limit,
    };
  }

  async listExecutionsForTrade(tradeId: string): Promise<ExecutionRow[]> {
    return [...this.state.executions.values()]
      .filter((row) => row.tradeId === tradeId)
      .sort((a, b) => (a.executedAt < b.executedAt ? -1 : 1));
  }

  async counts() {
    const buyHistory = [...this.state.executions.values()].filter((row) => row.side === "BUY").length;
    return {
      users: this.state.users.size,
      brokerAccounts: this.state.brokerAccounts.size,
      instruments: this.state.instruments.size,
      intents: this.state.intents.size,
      orders: this.state.orders.size,
      orderEvents: this.state.orderEvents.length,
      executions: this.state.executions.size,
      positions: this.state.positions.size,
      trades: this.state.trades.size,
      buyHistory,
      reconRuns: this.state.reconRuns.length,
      reconItems: this.state.reconItems.length,
      cashSnapshots: this.state.cash.length,
      accountSnapshots: this.state.accounts.length,
      audits: this.state.audits.length,
      migrationRuns: this.state.migrations.length,
    };
  }
}

export function failingLedger(message = "forced mirror failure"): Ledger {
  return {
    async transaction() {
      throw new Error(message);
    },
  };
}

export function uniqueId(): string {
  return newId();
}
