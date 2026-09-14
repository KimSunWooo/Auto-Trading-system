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
  | "deleted";
export type OrderSource = "condition" | "dca" | "manual";
export type OrderStatus = "filled" | "rejected";

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
  lastMessage?: string;
};

export type Order = {
  id: string;
  createdAt: string;
  source: OrderSource;
  sourceId?: string;
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
  reason?: string;
};

export type Settings = {
  ignoreMarketHours: boolean;
  startingCash: number;
};

export type AppState = {
  updatedAt: string;
  tickCount: number;
  settings: Settings;
  cash: number;
  positions: Position[];
  quotes: Record<string, Quote>;
  conditions: AutoCondition[];
  dcaPlans: DcaPlan[];
  orders: Order[];
};

export type PublicState = AppState & {
  equity: number;
  market: {
    timezone: "Asia/Seoul";
    now: string;
    open: boolean;
    sessionLabel: string;
  };
};
