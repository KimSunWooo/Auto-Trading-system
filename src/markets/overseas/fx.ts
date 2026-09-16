export type FxQuote = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  timestamp: string;
  source: "kis" | "unavailable";
};

export type ForeignCashBalance = {
  currency: string;
  cash: number;
  orderableCash: number;
  exchangeRate: number | null;
  krwEquivalent: number | null;
};

export type OverseasRiskExposure = {
  nativeCurrency: string;
  nativeValue: number;
  fxRate: number | null;
  krwEquivalent: number | null;
};

export function usdKrwPair(rate: number, timestamp = new Date().toISOString(), source: FxQuote["source"] = "kis"): FxQuote {
  return {
    baseCurrency: "USD",
    quoteCurrency: "KRW",
    rate,
    timestamp,
    source,
  };
}

/** USD × USD/KRW = KRW. Missing/invalid rate is not invented. */
export function krwEquivalent(nativeValue: number, fxRate: number | null | undefined): number | null {
  if (!Number.isFinite(nativeValue)) return null;
  if (fxRate == null || !Number.isFinite(fxRate) || fxRate <= 0) return null;
  return nativeValue * fxRate;
}

export function overseasOrderExposure(input: {
  qty: number;
  nativePrice: number;
  nativeCurrency?: string;
  fxRate?: number | null;
}): OverseasRiskExposure {
  const nativeValue = Math.max(0, input.qty) * Math.max(0, input.nativePrice);
  return {
    nativeCurrency: input.nativeCurrency ?? "USD",
    nativeValue,
    fxRate: input.fxRate ?? null,
    krwEquivalent: krwEquivalent(nativeValue, input.fxRate),
  };
}

export function pickUsdCash(rows: ForeignCashBalance[]): ForeignCashBalance | null {
  return rows.find((row) => row.currency === "USD") ?? null;
}
