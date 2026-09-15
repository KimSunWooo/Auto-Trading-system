import type { StrategyConfigFile } from "@/src/strategies/params";
import type { ProductRisk } from "@/src/risk/product";

export type Market = "KOSPI" | "KOSDAQ";
export type Side = "buy" | "sell";
export type WatchBasis = "last" | "bid" | "ask";
export type CompareOp = "gte" | "lte";
export type OrderPriceType = "market" | "limit";
export type ConditionStatus =
  | "watching"
  | "paused"
  | "filled"
  | "expired"
  | "rejected"
  | "unknown"
  | "deleted";
export type OrderSource = "condition" | "dca" | "manual" | "strategy";
export type OrderStatus = "pending" | "unknown" | "filled" | "rejected" | "cancelled";
export type BrokerDriver = "mock" | "kis";

export type Quote = {
  code: string;
  name: string;
  market: Market;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  bid: number;
  ask: number;
  history: number[];
};

export type Position = {
  code: string;
  name: string;
  qty: number;
  avgPrice: number;
  strategy: string;
};

export type Allocation = {
  strategy: string;
  riskLevel: number;
  budget: number;
  balance: number;
  enabled: boolean;
  lastRunAt?: string;
  lastMessage?: string;
  meta?: Record<string, string | number | boolean | null>;
};

export type AutoCondition = {
  id: string;
  code: string;
  name: string;
  side: Side;
  watchBasis: WatchBasis;
  operator: CompareOp;
  triggerPrice: number;
  volumeEnabled: boolean;
  volumeOp: CompareOp;
  volume: number;
  qty: number;
  orderPriceType: OrderPriceType;
  limitPrice: number | null;
  expiresAt: string;
  watching: boolean;
  status: ConditionStatus;
  createdAt: string;
  strategy?: string;
  filledAt?: string;
  filledOrderId?: string;
  message?: string;
};

export type DcaPlan = {
  id: string;
  code: string;
  name: string;
  amountKrw: number;
  intervalSec: number;
  nextRunAt: string;
  enabled: boolean;
  createdAt: string;
  runCount: number;
  strategy?: string;
  lastMessage?: string;
};

export type Order = {
  id: string;
  createdAt: string;
  source: OrderSource;
  sourceId?: string;
  strategy?: string;
  code: string;
  name: string;
  side: Side;
  qty: number;
  price: number;
  amount: number;
  commission: number;
  tax: number;
  net: number;
  status: OrderStatus;
  realizedPnl?: number;
  reason?: string;
  intentId?: string;
  brokerOrderNo?: string;
  krxOrgNo?: string;
  ordDvsn?: "market" | "limit";
  orderedQty?: number;
  filledQty?: number;
  parentOrderId?: string;
};

export type CircuitKind = "unknown" | "daily-loss" | "kill" | "balance" | "hard";

export type CircuitState = {
  halted: boolean;
  kind?: CircuitKind;
  reason?: string;
  unknownCount: number;
  openedAt?: string;
  lastError?: string;
};

export type DayStartMark = {
  date: string;
  equity: number;
};

export type KisHolding = {
  ticker: string;
  name: string;
  qty: number;
  avgPrice: number;
};

export type KisBalanceSnapshot = {
  syncedAt: string;
  cash: number;
  d2Cash: number;
  holdings: KisHolding[];
  cashDelta: number;
  matched: boolean;
  message: string;
};

export type Settings = {
  ignoreMarketHours: boolean;
  startingCash: number;
  broker: BrokerDriver;
  autoTrading: boolean;
  onboardingComplete: boolean;
  risk: ProductRisk;
};

export type AppState = {
  updatedAt: string;
  tickCount: number;
  lastEngineAt?: number;
  lastBalanceSyncAt?: number;
  settings: Settings;
  totalDeposit: number;
  allocations: Allocation[];
  cash: number;
  positions: Position[];
  quotes: Record<string, Quote>;
  conditions: AutoCondition[];
  dcaPlans: DcaPlan[];
  orders: Order[];
  circuit: CircuitState;
  dayStart: DayStartMark;
  equityHistory: number[];
  kisBalance?: KisBalanceSnapshot;
};

export type BrokerPublicStatus = {
  driver: BrokerDriver;
  mode: "demo" | "real" | null;
  configured: boolean;
  liveEnabled: boolean;
  accountMasked: string | null;
  message: string;
};

export type PublicState = AppState & {
  equity: number;
  market: {
    timezone: "Asia/Seoul";
    now: string;
    open: boolean;
    sessionLabel: string;
  };
  broker: BrokerPublicStatus;
  strategyConfig: StrategyConfigFile;
};
