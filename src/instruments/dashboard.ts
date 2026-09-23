import { toInstrumentRef, type InstrumentRef } from "@/src/instruments/types";

/** Config-dashboard representative tickers — not hardcoded in UI components. */
const KR_REPRESENTATIVES: Array<{ market: string; symbol: string; displayName: string; koreanName: string }> = [
  { market: "KOSPI", symbol: "005930", displayName: "삼성전자", koreanName: "삼성전자" },
  { market: "KOSPI", symbol: "000660", displayName: "SK하이닉스", koreanName: "SK하이닉스" },
  { market: "KOSPI", symbol: "035420", displayName: "NAVER", koreanName: "NAVER" },
  { market: "KOSPI", symbol: "035720", displayName: "카카오", koreanName: "카카오" },
  { market: "KOSPI", symbol: "005380", displayName: "현대차", koreanName: "현대차" },
];

const US_REPRESENTATIVES: Array<{ market: string; symbol: string; displayName: string; englishName: string }> = [
  { market: "NASDAQ", symbol: "AAPL", displayName: "Apple", englishName: "Apple" },
  { market: "NASDAQ", symbol: "MSFT", displayName: "Microsoft", englishName: "Microsoft" },
  { market: "NASDAQ", symbol: "NVDA", displayName: "NVIDIA", englishName: "NVIDIA" },
  { market: "NASDAQ", symbol: "TSLA", displayName: "Tesla", englishName: "Tesla" },
  { market: "NASDAQ", symbol: "AMZN", displayName: "Amazon", englishName: "Amazon" },
];

export function configDashboardRepresentatives(country?: "KR" | "US" | string): InstrumentRef[] {
  const filter = country ? String(country).toUpperCase() : null;
  const rows: InstrumentRef[] = [];
  if (!filter || filter === "KR") {
    for (const row of KR_REPRESENTATIVES) {
      rows.push(
        toInstrumentRef({
          country: "KR",
          market: row.market,
          symbol: row.symbol,
          displayName: row.displayName,
          koreanName: row.koreanName,
          currency: "KRW",
        }),
      );
    }
  }
  if (!filter || filter === "US") {
    for (const row of US_REPRESENTATIVES) {
      rows.push(
        toInstrumentRef({
          country: "US",
          market: row.market,
          symbol: row.symbol,
          displayName: row.displayName,
          englishName: row.englishName,
          currency: "USD",
        }),
      );
    }
  }
  return rows;
}
