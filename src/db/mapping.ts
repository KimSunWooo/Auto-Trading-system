import type { AppState, Order, OrderIntent, OrderStatus, Side } from "@/lib/types";
import { brokerDriver, loadKisConfig, maskAccountNo, parseAccountNo, resolveKisEnvironment } from "@/src/brokers/kis-config";
import { tradingMode, type EnvMap } from "@/src/runtime/trading-mode";
import { UNIVERSE } from "@/lib/universe";
import { US_SEED_UNIVERSE } from "@/src/markets/overseas/instruments";
import { CASH_RULE_ID } from "@/src/rules/params";
import { getRuleConfig } from "@/src/rules/config";
import { stableId } from "@/src/db/ids";
import { money } from "@/src/db/money";
import { mysqlDateUtc, toMysqlUtc } from "@/src/db/time";

export type DbEnv = "MOCK" | "PAPER" | "REAL";
export type DbBroker = "MOCK" | "KIS";

export function ledgerEnvironment(env: EnvMap = process.env): DbEnv {
  if (brokerDriver(env) !== "kis") return "MOCK";
  try {
    return resolveKisEnvironment(env) === "real" ? "REAL" : "PAPER";
  } catch {
    return "PAPER";
  }
}

export function ledgerBroker(env: EnvMap = process.env): DbBroker {
  return brokerDriver(env) === "kis" ? "KIS" : "MOCK";
}

export function instrumentIdFor(code: string): string {
  const symbol = String(code ?? "").trim();
  if (/^\d{6}$/.test(symbol)) {
    const seed = UNIVERSE.find((row) => row.code === symbol);
    const market = seed?.market ?? "KOSPI";
    return stableId("instrument", `KR:${market}:${symbol}`);
  }
  const identity = symbol.includes(":") ? symbol : `NASDAQ:${symbol.toUpperCase()}`;
  const [exchange, ticker] = identity.split(":");
  const market = exchange === "NYSE" || exchange === "AMEX" ? exchange : "NASDAQ";
  return stableId("instrument", `US:${market}:${(ticker ?? symbol).toUpperCase()}`);
}

export function describeInstrument(code: string): {
  id: string;
  country: "KR" | "US";
  market: string;
  symbol: string;
  displayName: string;
  currency: "KRW" | "USD";
  kisExchangeCode: string | null;
} {
  const symbol = String(code ?? "").trim();
  if (/^\d{6}$/.test(symbol)) {
    const seed = UNIVERSE.find((row) => row.code === symbol);
    return {
      id: instrumentIdFor(symbol),
      country: "KR",
      market: seed?.market ?? "KOSPI",
      symbol,
      displayName: seed?.name ?? symbol,
      currency: "KRW",
      kisExchangeCode: "KRX",
    };
  }
  const identity = symbol.includes(":") ? symbol : `NASDAQ:${symbol.toUpperCase()}`;
  const [exchangeRaw, tickerRaw] = identity.split(":");
  const market = exchangeRaw === "NYSE" || exchangeRaw === "AMEX" ? exchangeRaw : "NASDAQ";
  const ticker = (tickerRaw ?? symbol).toUpperCase();
  const seed = US_SEED_UNIVERSE.find((row) => row.symbol === ticker);
  return {
    id: instrumentIdFor(identity),
    country: "US",
    market,
    symbol: ticker,
    displayName: seed?.displayName ?? ticker,
    currency: "USD",
    kisExchangeCode: market === "NYSE" ? "NYSE" : market === "AMEX" ? "AMEX" : "NASD",
  };
}

export function mapOrderStatus(order: Order): string {
  const filled = order.filledQty ?? 0;
  const ordered = order.orderedQty ?? order.qty;
  if (order.status === "unknown") return "UNKNOWN";
  if (order.status === "rejected") return "REJECTED";
  if (order.status === "cancelled") return "CANCELLED";
  if (order.status === "filled") return "FILLED";
  if (order.status === "pending" && filled > 0 && filled < ordered) return "PARTIALLY_FILLED";
  if (order.status === "pending" && order.brokerOrderNo) return "ACCEPTED";
  return "PENDING";
}

export function mapIntentStatus(intent: OrderIntent): string {
  const status = intent.status.toUpperCase();
  if (status === "SUBMITTED") return "SUBMITTED";
  if (status === "FILLED") return "FILLED";
  if (status === "REJECTED") return "REJECTED";
  if (status === "UNKNOWN") return "UNKNOWN";
  if (status === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

export function mapSide(side: Side): "BUY" | "SELL" {
  return side === "sell" ? "SELL" : "BUY";
}

export function parentOrders(state: AppState): Order[] {
  return state.orders.filter((order) => !order.parentOrderId);
}

export function fillChildren(state: AppState, parentId: string): Order[] {
  return state.orders.filter(
    (order) => order.parentOrderId === parentId && order.status === "filled" && order.qty > 0,
  );
}

export function executionKeyFor(order: Order, parent: Order | undefined, cumulativeQty: number): string {
  if (parent) return `local:${parent.id}:${order.id}`;
  return `local:${order.id}:${cumulativeQty}`;
}

export function maskedAccount(env: EnvMap = process.env): string | null {
  if (brokerDriver(env) !== "kis") return null;
  const kis = loadKisConfig(env);
  const parsed = parseAccountNo(kis.accountNo);
  if (!parsed) return null;
  return maskAccountNo(parsed.cano, parsed.productCode);
}

export function credentialRef(env: EnvMap = process.env): string | null {
  const broker = ledgerBroker(env);
  const environment = ledgerEnvironment(env);
  if (broker === "MOCK") return "env:MOCK";
  if (environment === "REAL") return "env:KIS_REAL";
  return "env:KIS_PAPER";
}

export function cashRuleKey(state: AppState): string {
  return state.allocations.find((row) => row.ruleId === CASH_RULE_ID)?.ruleId ?? CASH_RULE_ID;
}

export { money, toMysqlUtc, mysqlDateUtc, getRuleConfig, tradingMode };
