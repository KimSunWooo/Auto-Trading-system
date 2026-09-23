import type { RuleConfigFile } from "@/src/rules/params";
import type { ProductRisk } from "@/src/risk/product";
import type { SafetyState } from "@/src/runtime/safety";
import type { ControlledRunState } from "@/src/runtime/controlled-run";

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
export type OrderSource = "condition" | "dca" | "manual" | "rule";
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
  source?: "mock" | "kis" | "seed";
  /** How the latest price arrived. Optional diagnostic; safety still keys off source+freshAt. */
  transport?: "rest" | "ws";
  freshAt?: number;
};

export type Position = {
  code: string;
  name: string;
  qty: number;
  avgPrice: number;
  ruleId: string;
};

export type Allocation = {
  ruleId: string;
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
  /** Additive master link — legacy conditions omit these. */
  instrumentId?: string;
  instrumentKey?: string;
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
  ruleId?: string;
  filledAt?: string;
  filledOrderId?: string;
  message?: string;
};

export type DcaPlan = {
  id: string;
  code: string;
  /** Additive master link — legacy DCA plans omit these. */
  instrumentId?: string;
  instrumentKey?: string;
  name: string;
  amountKrw: number;
  intervalSec: number;
  nextRunAt: string;
  enabled: boolean;
  createdAt: string;
  runCount: number;
  ruleId?: string;
  lastMessage?: string;
};

export type Order = {
  id: string;
  createdAt: string;
  source: OrderSource;
  sourceId?: string;
  ruleId?: string;
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
  /** Startup sync classification. Orphaned/historical do not block trading. */
  activeClass?:
    | "ACTIVE_MATCHED"
    | "HISTORICAL_MATCHED"
    | "ORPHANED_LOCAL"
    | "UNKNOWN_ACTIVE";
  provenance?: string;
};

export type CircuitKind =
  | "unknown"
  | "daily-loss"
  | "kill"
  | "balance"
  | "hard"
  | "recon"
  | "data"
  | "soak-stop";

export type OrderIntentStatus =
  | "pending"
  | "submitted"
  | "filled"
  | "rejected"
  | "unknown"
  | "cancelled";

export type OrderIntent = {
  intentId: string;
  signalId: string;
  ruleId: string;
  ticker: string;
  side: Side;
  qty: number;
  price: number;
  createdAt: string;
  reason: string;
  status: OrderIntentStatus;
  orderId?: string;
  brokerOrderNo?: string;
};

export type RuntimePublic = {
  tradingMode: "mock" | "paper" | "live_test" | "live";
  allowLiveTrading: boolean;
  httpTickAllowed: boolean;
  tradingStatus: "running" | "blocked" | "stopped";
  worker: "healthy" | "unhealthy";
  brokerLink: "connected" | "disconnected";
  marketStatus: "open" | "closed" | "unknown";
  risk: "normal" | "warning" | "blocked";
  reconciliation: "synced" | "mismatch" | "unavailable" | "pending";
  lastTickAt?: number;
  lastOrderAt?: number;
  lastError?: string;
  lastErrorAt?: string;
  ordersAllowed: boolean;
  autoTrading: "on" | "paused" | "stopped";
  selectedStrategy?: string;
  currentSymbols?: string[];
  soakStatus?: "idle" | "running" | "paused" | "stopped";
  todayOrders?: number;
  todayExecutions?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  rdsMirror?: "connected" | "degraded" | "off";
};

export type CircuitState = {
  halted: boolean;
  kind?: CircuitKind;
  reason?: string;
  unknownCount: number;
  openedAt?: string;
  lastError?: string;
};

export type KillReport = {
  cancelled: number;
  flattened: number;
  overwritten: boolean;
  notes: string[];
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
  /** Same instant as `syncedAt`. Broker read time, not a new recon run. */
  fetchedAt?: string;
  /** Broker deposit cash (`dnca_tot_amt`). Not local ledger cash. */
  cash: number;
  /** D+2 settle amount (`prvs_rcdl_excc_amt`). Not orderable cash. */
  d2Cash: number;
  /** Broker orderable cash (`ord_psbl_cash`) when inquire-psbl-order was read. */
  orderableCash?: number;
  /** 미수없는매수금액 `nrcvb_buy_amt`. Diagnostics only. */
  nrcvbBuyAmt?: number;
  thdtBuyAmt?: number;
  thdtTlexAmt?: number;
  nxdyExccAmt?: number;
  holdings: KisHolding[];
  cashDelta: number;
  matched: boolean;
  freshness?: "fresh" | "stale" | "unknown";
  message: string;
};

export type Settings = {
  ignoreMarketHours: boolean;
  startingCash: number;
  broker: BrokerDriver;
  autoTrading: boolean;
  onboardingComplete: boolean;
  liquidating: boolean;
  disclaimerAccepted: boolean;
  disclaimerAcceptedAt?: string;
  risk: ProductRisk;
};

export type StartupSyncPublic = {
  status: "IDLE" | "SYNCING" | "HEALTHY" | "FAILED";
  lastSyncedAt?: string;
  recoveredOrders: number;
  orphanedOrders: number;
  positionChanges: number;
  executionChanges: number;
  message?: string;
};

/** First successful PAPER sync marker — never reset on every restart. */
export type PaperBrokerBaseline = {
  source: "KIS_PAPER";
  initializedAt: string;
  depositCash: number;
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
  killReport?: KillReport;
  intents?: OrderIntent[];
  safety?: SafetyState;
  controlledRun?: ControlledRunState;
  startupSync?: StartupSyncPublic;
  /** Present after first healthy PAPER broker sync. */
  paperBrokerBaseline?: PaperBrokerBaseline;
};

export type BrokerPublicStatus = {
  driver: BrokerDriver;
  mode: "paper" | "real" | null;
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
  ruleConfig: RuleConfigFile;
  runtime: RuntimePublic;
};
