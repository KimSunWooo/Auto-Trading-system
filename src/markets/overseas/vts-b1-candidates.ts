import { krwEquivalent } from "@/src/markets/overseas/fx";
import { makeUsInstrument, type UsExchange } from "@/src/markets/overseas/instruments";
import { overseasMaxUsdPricePerShare, overseasOneShareEligibility } from "@/src/markets/overseas/preflight";
import { DEFAULT_LIVE_TEST_CAPS } from "@/src/runtime/trading-mode";
import type { OverseasMarketStatus, OverseasQuote } from "@/src/markets/overseas/types";

/**
 * Read-only VTS-B1 quote probes. Not the UI seed universe.
 * Well-known NASDAQ/NYSE listings that may fit the 10,000 KRW 1-share cap.
 * Order is selection priority (not cheapest-first).
 */
export const US_VTS_B1_PROBE_UNIVERSE: Array<{ exchange: UsExchange; symbol: string; displayName: string }> = [
  { exchange: "NYSE", symbol: "F", displayName: "Ford" },
  { exchange: "NYSE", symbol: "NOK", displayName: "Nokia" },
  { exchange: "NASDAQ", symbol: "SOFI", displayName: "SoFi" },
  { exchange: "NASDAQ", symbol: "AAL", displayName: "American Airlines" },
  { exchange: "NASDAQ", symbol: "SIRI", displayName: "Sirius XM" },
  { exchange: "NYSE", symbol: "SNAP", displayName: "Snap" },
  { exchange: "NYSE", symbol: "NIO", displayName: "NIO" },
  { exchange: "NYSE", symbol: "WBD", displayName: "Warner Bros Discovery" },
  { exchange: "NYSE", symbol: "ERIC", displayName: "Ericsson" },
  { exchange: "NYSE", symbol: "BB", displayName: "BlackBerry" },
  { exchange: "NASDAQ", symbol: "LCID", displayName: "Lucid" },
  { exchange: "NYSE", symbol: "ABEV", displayName: "Ambev" },
  { exchange: "NYSE", symbol: "VALE", displayName: "Vale" },
  { exchange: "NYSE", symbol: "ITUB", displayName: "Itau Unibanco" },
  { exchange: "NASDAQ", symbol: "PLUG", displayName: "Plug Power" },
];

/** Skip extreme pennies that look like bad ticks, not a normal 1-share lifecycle test. */
export const VTS_B1_MIN_NORMAL_USD = 1;

export type OverseasVtsB1Candidate = {
  symbol: string;
  name: string;
  exchange: UsExchange;
  priceUsd: number | null;
  fxRate: number;
  krwNotional: number | null;
  riskEligible: boolean;
  quoteAvailable: boolean;
  marketStatus: OverseasMarketStatus | "unknown";
  anomaly: string | null;
};

export function evaluateVtsB1Quote(input: {
  exchange: UsExchange;
  symbol: string;
  displayName: string;
  quote: OverseasQuote | null;
  fxRate: number;
  usdOrderable: number;
  maxOrderKrw?: number;
}): OverseasVtsB1Candidate {
  const maxOrderKrw = input.maxOrderKrw ?? DEFAULT_LIVE_TEST_CAPS.maxOrderKrw;
  const quote = input.quote;
  const priceUsd = quote && quote.price > 0 ? quote.price : null;
  const quoteAvailable = priceUsd != null && quote?.source === "kis";
  let anomaly: string | null = null;
  if (!quoteAvailable) anomaly = "KIS quote unavailable";
  else if (priceUsd != null && priceUsd < VTS_B1_MIN_NORMAL_USD) anomaly = "price below normal 1 USD floor";
  const eligibility =
    quoteAvailable && priceUsd != null
      ? overseasOneShareEligibility({
          symbol: input.symbol,
          nativePrice: priceUsd,
          usdOrderable: input.usdOrderable,
          fxRate: input.fxRate,
          qty: 1,
        })
      : null;
  const krwNotional =
    eligibility?.krwNotional ?? (priceUsd != null ? krwEquivalent(priceUsd, input.fxRate) : null);
  const riskEligible = Boolean(eligibility?.eligible) && anomaly == null;
  return {
    symbol: input.symbol,
    name: quote?.displayName || input.displayName,
    exchange: input.exchange,
    priceUsd,
    fxRate: input.fxRate,
    krwNotional,
    riskEligible,
    quoteAvailable,
    marketStatus: quote?.marketStatus ?? "unknown",
    anomaly,
  };
}

/** First priority listing that is quote-healthy, >= $1, and within the 10,000 KRW cap. Not cheapest-first. */
export function selectVtsB1Instrument(
  rows: OverseasVtsB1Candidate[],
): OverseasVtsB1Candidate | null {
  for (const probe of US_VTS_B1_PROBE_UNIVERSE) {
    const row = rows.find((item) => item.exchange === probe.exchange && item.symbol === probe.symbol);
    if (row?.riskEligible && row.quoteAvailable && (row.priceUsd ?? 0) >= VTS_B1_MIN_NORMAL_USD) {
      return row;
    }
  }
  return null;
}

export function vtsB1MaxUsdPrice(fxRate: number, maxOrderKrw = DEFAULT_LIVE_TEST_CAPS.maxOrderKrw): number | null {
  return overseasMaxUsdPricePerShare(fxRate, maxOrderKrw);
}

export function probeInstrument(exchange: UsExchange, symbol: string, displayName: string) {
  return makeUsInstrument(exchange, symbol, displayName);
}
