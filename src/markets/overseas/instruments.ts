/**
 * Overseas instrument identity. Domestic 6-digit codes are not valid here.
 *
 * KIS uses two exchange code families:
 *   quote EXCD     = NAS / NYS / AMS
 *   trading OVRS_EXCG_CD = NASD / NYSE / AMEX
 * UI display names stay NASDAQ / NYSE / AMEX and never get sent as EXCD.
 */

export const TRADING_VENUE = {
  domestic: "domestic",
  overseas: "overseas",
} as const;
export type TradingVenue = (typeof TRADING_VENUE)[keyof typeof TRADING_VENUE];

export const OVERSEAS_MARKET = "OVERSEAS" as const;
export type OverseasMarket = typeof OVERSEAS_MARKET;

export const US_COUNTRY = "US" as const;
export const USD = "USD" as const;

export const US_EXCHANGES = ["NASDAQ", "NYSE", "AMEX"] as const;
export type UsExchange = (typeof US_EXCHANGES)[number];

/** Official overseas-price EXCD (HHDFS00000300). */
export const KIS_QUOTE_EXCD = {
  NASDAQ: "NAS",
  NYSE: "NYS",
  AMEX: "AMS",
} as const;
export type KisQuoteExcd = (typeof KIS_QUOTE_EXCD)[UsExchange];

/** Official overseas trading OVRS_EXCG_CD (balance/order/nccs). */
export const KIS_TRADING_EXCG = {
  NASDAQ: "NASD",
  NYSE: "NYSE",
  AMEX: "AMEX",
} as const;
export type KisTradingExcg = (typeof KIS_TRADING_EXCG)[UsExchange];

/** Official search-info PRDT_TYPE_CD for US listings. */
export const KIS_US_PRODUCT_TYPE = {
  NASDAQ: "512",
  NYSE: "513",
  AMEX: "529",
} as const;

export type OverseasInstrument = {
  market: OverseasMarket;
  country: typeof US_COUNTRY;
  /** UI / identity exchange. */
  exchange: UsExchange;
  symbol: string;
  displayName: string;
  currency: typeof USD;
  /** KIS price EXCD. */
  quoteExcd: KisQuoteExcd;
  /** KIS trading OVRS_EXCG_CD. */
  tradingExcg: KisTradingExcg;
  productTypeCd: string;
};

export function overseasIdentity(exchange: UsExchange, symbol: string): string {
  return `${exchange}:${normalizeOverseasSymbol(symbol)}`;
}

export function normalizeOverseasSymbol(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "");
}

export function isUsExchange(value: string): value is UsExchange {
  return (US_EXCHANGES as readonly string[]).includes(value);
}

export function quoteExcdToExchange(excd: string): UsExchange | null {
  const raw = String(excd ?? "").trim().toUpperCase();
  if (raw === "NAS" || raw === "NASD" || raw === "NASDAQ") return "NASDAQ";
  if (raw === "NYS" || raw === "NYSE") return "NYSE";
  if (raw === "AMS" || raw === "AMEX") return "AMEX";
  return null;
}

export function tradingExcgToExchange(code: string): UsExchange | null {
  return quoteExcdToExchange(code);
}

export function exchangeToQuoteExcd(exchange: UsExchange): KisQuoteExcd {
  return KIS_QUOTE_EXCD[exchange];
}

export function exchangeToTradingExcg(exchange: UsExchange): KisTradingExcg {
  return KIS_TRADING_EXCG[exchange];
}

export function makeUsInstrument(
  exchange: UsExchange,
  symbol: string,
  displayName?: string,
): OverseasInstrument {
  const ticker = normalizeOverseasSymbol(symbol);
  if (!ticker) {
    throw new Error("해외주식 심볼이 비어 있습니다.");
  }
  return {
    market: OVERSEAS_MARKET,
    country: US_COUNTRY,
    exchange,
    symbol: ticker,
    displayName: displayName?.trim() || ticker,
    currency: USD,
    quoteExcd: exchangeToQuoteExcd(exchange),
    tradingExcg: exchangeToTradingExcg(exchange),
    productTypeCd: KIS_US_PRODUCT_TYPE[exchange],
  };
}

/**
 * Accepts `NASDAQ:AAPL`, `NAS:AAPL`, `NASD:AAPL`, or a bare ticker plus default exchange.
 * Bare tickers never imply a domestic 6-digit code.
 */
export function parseOverseasInstrument(
  raw: string,
  fallbackExchange: UsExchange = "NASDAQ",
): OverseasInstrument | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parts = text.split(/[:/]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const exchange = quoteExcdToExchange(parts[0]!);
    const symbol = normalizeOverseasSymbol(parts.slice(1).join(""));
    if (!exchange || !symbol) return null;
    return makeUsInstrument(exchange, symbol);
  }
  const symbol = normalizeOverseasSymbol(text);
  if (!symbol || /^\d{6}$/.test(symbol)) return null;
  return makeUsInstrument(fallbackExchange, symbol);
}

export function sameOverseasIdentity(a: string | undefined, b: string | undefined): boolean {
  const left = parseOverseasInstrument(String(a ?? ""));
  const right = parseOverseasInstrument(String(b ?? ""));
  if (!left || !right) return false;
  return left.exchange === right.exchange && left.symbol === right.symbol;
}

export const US_SEED_UNIVERSE: Array<{ exchange: UsExchange; symbol: string; displayName: string }> = [
  { exchange: "NASDAQ", symbol: "AAPL", displayName: "Apple" },
  { exchange: "NASDAQ", symbol: "MSFT", displayName: "Microsoft" },
  { exchange: "NASDAQ", symbol: "NVDA", displayName: "NVIDIA" },
  { exchange: "NASDAQ", symbol: "AMZN", displayName: "Amazon" },
  { exchange: "NASDAQ", symbol: "GOOGL", displayName: "Alphabet" },
  { exchange: "NASDAQ", symbol: "META", displayName: "Meta" },
  { exchange: "NASDAQ", symbol: "TSLA", displayName: "Tesla" },
  { exchange: "NYSE", symbol: "KO", displayName: "Coca-Cola" },
  { exchange: "NYSE", symbol: "JPM", displayName: "JPMorgan" },
  { exchange: "AMEX", symbol: "SPY", displayName: "SPDR S&P 500" },
];
