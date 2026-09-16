export type UserRow = {
  id: string;
  email: string | null;
  displayName: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type BrokerAccountRow = {
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
};

export type InstrumentRow = {
  id: string;
  country: string;
  market: string;
  symbol: string;
  displayName: string;
  currency: string;
  kisExchangeCode: string | null;
  instrumentType: string;
  isActive: boolean;
};

export type IntentRow = {
  id: string;
  brokerAccountId: string;
  instrumentId: string;
  intentKey: string;
  ruleKey: string;
  source: string;
  side: string;
  quantity: string;
  referencePrice: string | null;
  orderType: string;
  tradingMode: string;
  status: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type OrderRow = {
  id: string;
  brokerAccountId: string;
  instrumentId: string;
  intentId: string | null;
  localOrderId: string;
  brokerOrderNo: string | null;
  brokerOrderDate: string | null;
  brokerOrgNo: string | null;
  side: string;
  orderType: string;
  requestedQty: string;
  requestedPrice: string | null;
  filledQty: string;
  remainingQty: string;
  averageFillPrice: string | null;
  currency: string;
  status: string;
  source: string | null;
  sourceId: string | null;
  ruleKey: string;
  reason: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrderEventRow = {
  id: string;
  orderId: string;
  eventType: string;
  previousStatus: string | null;
  newStatus: string | null;
  eventAt: string;
};

export type ExecutionRow = {
  id: string;
  brokerAccountId: string;
  orderId: string;
  instrumentId: string;
  tradeId: string | null;
  executionKey: string;
  brokerExecutionId: string | null;
  brokerOrderNo: string | null;
  side: string;
  quantity: string;
  price: string;
  grossAmount: string;
  commission: string;
  tax: string;
  otherFee: string;
  realizedPnl: string | null;
  currency: string;
  executedAt: string;
  createdAt: string;
};

export type PositionRow = {
  id: string;
  brokerAccountId: string;
  instrumentId: string;
  ruleScope: string;
  quantity: string;
  availableQuantity: string;
  averagePrice: string;
  totalCost: string;
  marketPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  unrealizedReturnPct: string | null;
  currency: string;
  provenance: string;
  updatedAt: string;
};

export type TradeRow = {
  id: string;
  brokerAccountId: string;
  instrumentId: string;
  ruleScope: string;
  source: string;
  status: string;
  totalBuyQty: string;
  totalSellQty: string;
  totalBuyAmount: string;
  totalSellAmount: string;
  averageBuyPrice: string | null;
  averageSellPrice: string | null;
  totalCommission: string;
  totalTax: string;
  totalOtherFee: string;
  realizedPnl: string;
  realizedReturnPct: string | null;
  currency: string;
  openedAt: string;
  closedAt: string | null;
};

export type CashSnapshotRow = {
  id: string;
  brokerAccountId: string;
  currency: string;
  cashBalance: string;
  orderableAmount: string;
  withdrawableAmount: string | null;
  source: string;
  capturedAt: string;
};

export type AccountSnapshotRow = {
  id: string;
  brokerAccountId: string;
  baseCurrency: string;
  totalAssetValue: string;
  cashValue: string;
  stockMarketValue: string;
  realizedPnl: string;
  unrealizedPnl: string;
  capturedAt: string;
};

export type FxSnapshotRow = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  source: string;
  capturedAt: string;
};

export type ReconRunRow = {
  id: string;
  brokerAccountId: string;
  triggerType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
};

export type ReconItemRow = {
  id: string;
  reconciliationRunId: string;
  itemType: string;
  instrumentId: string | null;
  localReference: string | null;
  brokerReference: string | null;
  localValueJson: unknown;
  brokerValueJson: unknown;
  status: string;
  message: string | null;
};

export type RiskDecisionRow = {
  id: string;
  intentId: string;
  decision: string;
  reasonCode: string | null;
  reasonText: string | null;
  requestedQty: string | null;
  requestedAmount: string | null;
};

export type RiskLimitsRow = {
  id: string;
  brokerAccountId: string;
  environment: string;
  maxOrderAmount: string | null;
  maxOrderQty: string | null;
  maxDailyOrderAmount: string | null;
  maxDailyOrders: number | null;
  maxPositionAmount: string | null;
  maxDailyLoss: string | null;
  allowTrading: boolean;
};

export type TradingAccountStateRow = {
  brokerAccountId: string;
  autoTradingEnabled: boolean;
  onboardingComplete: boolean;
  liquidating: boolean;
  circuitHalted: boolean;
  circuitKind: string | null;
  circuitReason: string | null;
  unknownOrderCount: number;
};

export type TradingRuleRow = {
  id: string;
  userId: string;
  brokerAccountId: string;
  ruleKey: string;
  instrumentId: string | null;
  name: string;
  kind: string;
  intervalMs: number | null;
  fastMa: number | null;
  slowMa: number | null;
  buyPct: string | null;
  sliceAmount: string | null;
  minAmount: string | null;
  stopLossPct: string | null;
  takeProfitPct: string | null;
  budget: string | null;
  enabled: boolean;
  configJson: unknown;
};

export type RuleAllocationRow = {
  id: string;
  brokerAccountId: string;
  ruleKey: string;
  budget: string;
  balance: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastMessage: string | null;
  metaJson: unknown;
};

export type AutoConditionRow = {
  id: string;
  brokerAccountId: string;
  conditionKey: string;
  instrumentId: string | null;
  status: string;
  configJson: unknown;
};

export type DcaPlanRow = {
  id: string;
  brokerAccountId: string;
  planKey: string;
  instrumentId: string;
  status: string;
  configJson: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export type AuditLogRow = {
  id: string;
  userId: string | null;
  brokerAccountId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  beforeDataJson: unknown;
  afterDataJson: unknown;
};

export type MigrationRunRow = {
  id: string;
  migrationType: string;
  sourcePath: string | null;
  status: string;
  importedOrders: number;
  importedIntents: number;
  importedPositions: number;
  importedRules: number;
  warningsJson: unknown;
  startedAt: string;
  finishedAt: string | null;
};

export type BuyHistoryRow = {
  executionId: string;
  brokerAccountId: string;
  userId: string;
  orderId: string;
  instrumentId: string;
  country: string;
  market: string;
  symbol: string;
  displayName: string;
  quantity: string;
  price: string;
  grossAmount: string;
  commission: string;
  tax: string;
  otherFee: string;
  currency: string;
  brokerOrderNo: string | null;
  executedAt: string;
};

export type HistoryFilter = {
  account?: string;
  country?: string;
  market?: string;
  symbol?: string;
  rule?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  limit: number;
};
