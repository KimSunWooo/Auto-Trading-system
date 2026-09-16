import type { ForeignCashBalance, FxQuote } from "@/src/markets/overseas/fx";
import type { OverseasInstrument, UsExchange } from "@/src/markets/overseas/instruments";

export type OverseasMarketStatus = "open" | "closed" | "unknown";

export type OverseasQuote = {
  identity: string;
  symbol: string;
  exchange: UsExchange;
  displayName: string;
  currency: "USD";
  price: number;
  prevClose: number;
  change: number;
  changeRate: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  timestamp: string;
  source: "kis";
  orderable: boolean | null;
  marketStatus: OverseasMarketStatus;
};

export type OverseasPosition = {
  identity: string;
  instrument: OverseasInstrument;
  qty: number;
  avgPrice: number;
  last: number;
  marketValue: number;
  currency: string;
  krwEquivalent: number | null;
};

export type OverseasOpenOrder = {
  orderNo: string;
  identity: string;
  symbol: string;
  exchange: UsExchange;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  remainingQty: number;
  price: number;
  currency: string;
};

export type OverseasExecution = {
  orderNo: string;
  identity: string;
  symbol: string;
  exchange: UsExchange;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  remainingQty: number;
  price: number;
  avgPrice: number;
  currency: string;
};

export type OverseasBuyingPower = {
  currency: "USD";
  orderableCash: number;
  orderableQty: number;
  exchange: UsExchange;
  symbol: string;
};

export type OverseasAccountSnapshot = {
  syncedAt: string;
  cash: ForeignCashBalance[];
  fx: FxQuote | null;
  buyingPower: OverseasBuyingPower | null;
  positions: OverseasPosition[];
  krwCash: number | null;
  estimatedKrwValue: number | null;
  message: string;
};

export type CurrencyExchangeAudit = {
  supported: "YES" | "NO" | "NOT VERIFIED";
  paperVtsExecutionSupported: "YES" | "NO" | "NOT VERIFIED";
  implementation: string;
  inquiryApis: string[];
};

export type OverseasPublicView = {
  quotes: OverseasQuote[];
  account: OverseasAccountSnapshot | null;
  exchangeAudit: CurrencyExchangeAudit;
  ordersEnabled: boolean;
};
