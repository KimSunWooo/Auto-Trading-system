/** Canonical instrument identity: `KR:KOSPI:005930`, `US:NASDAQ:AAPL`. */

export const KR_AUTOMATION_MARKETS = ["KOSPI", "KOSDAQ", "KONEX"] as const;
export const US_AUTOMATION_MARKETS = ["NASDAQ", "NYSE", "AMEX"] as const;

export type KrAutomationMarket = (typeof KR_AUTOMATION_MARKETS)[number];
export type UsAutomationMarket = (typeof US_AUTOMATION_MARKETS)[number];

export type InstrumentCountry = "KR" | "US" | string;
export type InstrumentMarket =
  | KrAutomationMarket
  | UsAutomationMarket
  | string;

export type InstrumentType = "STOCK" | "ETF" | "ETN" | "OTHER" | string;

export type InstrumentRef = {
  /** Stable UUID when persisted; may be absent for seed-only hits. */
  id?: string;
  /** `COUNTRY:MARKET:SYMBOL` */
  instrumentKey: string;
  country: InstrumentCountry;
  market: InstrumentMarket;
  symbol: string;
  displayName: string;
  koreanName?: string | null;
  englishName?: string | null;
  currency: string;
  instrumentType: InstrumentType;
  /** True for KOSPI/KOSDAQ/KONEX and NASDAQ/NYSE/AMEX only. */
  automationSupported: boolean;
  isActive?: boolean;
  kisExchangeCode?: string | null;
  aliases?: string[];
};

export type InstrumentSearchHit = InstrumentRef & {
  rank: number;
  matchedOn: "exact_symbol" | "exact_name" | "symbol_prefix" | "name_prefix" | "alias_prefix" | "contains";
};

export type InstrumentSearchQuery = {
  q: string;
  country?: string;
  market?: string;
  type?: string;
  limit?: number;
};

export function makeInstrumentKey(country: string, market: string, symbol: string): string {
  return `${String(country).toUpperCase()}:${String(market).toUpperCase()}:${String(symbol).trim()}`;
}

export function parseInstrumentKey(key: string): {
  country: string;
  market: string;
  symbol: string;
} | null {
  const parts = String(key ?? "")
    .trim()
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const [country, market, ...rest] = parts;
  const symbol = rest.join(":");
  if (!country || !market || !symbol) return null;
  return { country: country.toUpperCase(), market: market.toUpperCase(), symbol };
}

export function automationSupportedFor(country: string, market: string): boolean {
  const c = String(country ?? "").toUpperCase();
  const m = String(market ?? "").toUpperCase();
  if (c === "KR") return (KR_AUTOMATION_MARKETS as readonly string[]).includes(m);
  if (c === "US") return (US_AUTOMATION_MARKETS as readonly string[]).includes(m);
  return false;
}

export function defaultCurrency(country: string): string {
  return String(country ?? "").toUpperCase() === "US" ? "USD" : "KRW";
}

export function defaultKisExchangeCode(country: string, market: string): string | null {
  const c = String(country ?? "").toUpperCase();
  const m = String(market ?? "").toUpperCase();
  if (c === "KR") return "KRX";
  if (m === "NASDAQ") return "NASD";
  if (m === "NYSE") return "NYSE";
  if (m === "AMEX") return "AMEX";
  return null;
}

export function toInstrumentRef(row: {
  id?: string;
  country: string;
  market: string;
  symbol: string;
  displayName: string;
  koreanName?: string | null;
  englishName?: string | null;
  currency?: string;
  instrumentType?: string;
  isActive?: boolean;
  kisExchangeCode?: string | null;
  aliases?: string[];
}): InstrumentRef {
  const country = String(row.country).toUpperCase();
  const market = String(row.market).toUpperCase();
  const symbol = String(row.symbol).trim();
  return {
    id: row.id,
    instrumentKey: makeInstrumentKey(country, market, symbol),
    country,
    market,
    symbol,
    displayName: row.displayName,
    koreanName: row.koreanName ?? null,
    englishName: row.englishName ?? null,
    currency: row.currency ?? defaultCurrency(country),
    instrumentType: row.instrumentType ?? "STOCK",
    automationSupported: automationSupportedFor(country, market),
    isActive: row.isActive ?? true,
    kisExchangeCode: row.kisExchangeCode ?? defaultKisExchangeCode(country, market),
    aliases: row.aliases,
  };
}
