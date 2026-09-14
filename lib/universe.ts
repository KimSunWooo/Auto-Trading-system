import type { Market } from "./types";

export type StockSeed = {
  code: string;
  name: string;
  market: Market;
  prevClose: number;
};

/** Realistic 2025–2026-era starting prices for the paper book. */
export const UNIVERSE: StockSeed[] = [
  { code: "005930", name: "삼성전자", market: "KOSPI", prevClose: 74800 },
  { code: "000660", name: "SK하이닉스", market: "KOSPI", prevClose: 187000 },
  { code: "373220", name: "LG에너지솔루션", market: "KOSPI", prevClose: 382000 },
  { code: "207940", name: "삼성바이오로직스", market: "KOSPI", prevClose: 1048000 },
  { code: "005380", name: "현대차", market: "KOSPI", prevClose: 218000 },
  { code: "000270", name: "기아", market: "KOSPI", prevClose: 102300 },
  { code: "068270", name: "셀트리온", market: "KOSPI", prevClose: 178500 },
  { code: "035420", name: "NAVER", market: "KOSPI", prevClose: 198700 },
  { code: "035720", name: "카카오", market: "KOSPI", prevClose: 42150 },
  { code: "051910", name: "LG화학", market: "KOSPI", prevClose: 312000 },
  { code: "006400", name: "삼성SDI", market: "KOSPI", prevClose: 348500 },
  { code: "105560", name: "KB금융", market: "KOSPI", prevClose: 89200 },
  { code: "055550", name: "신한지주", market: "KOSPI", prevClose: 54800 },
  { code: "086790", name: "하나금융지주", market: "KOSPI", prevClose: 62400 },
  { code: "012330", name: "현대모비스", market: "KOSPI", prevClose: 265000 },
  { code: "066570", name: "LG전자", market: "KOSPI", prevClose: 87600 },
  { code: "028260", name: "삼성물산", market: "KOSPI", prevClose: 156800 },
  { code: "003670", name: "포스코퓨처엠", market: "KOSPI", prevClose: 142300 },
  { code: "096770", name: "SK이노베이션", market: "KOSPI", prevClose: 118400 },
  { code: "017670", name: "SK텔레콤", market: "KOSPI", prevClose: 56200 },
  { code: "030200", name: "KT", market: "KOSPI", prevClose: 47850 },
  { code: "259960", name: "크래프톤", market: "KOSPI", prevClose: 312000 },
  { code: "352820", name: "하이브", market: "KOSPI", prevClose: 198400 },
  { code: "247540", name: "에코프로비엠", market: "KOSDAQ", prevClose: 142700 },
  { code: "086520", name: "에코프로", market: "KOSDAQ", prevClose: 86500 },
  { code: "196170", name: "알테오젠", market: "KOSDAQ", prevClose: 368000 },
  { code: "058470", name: "리노공업", market: "KOSDAQ", prevClose: 187500 },
  { code: "041510", name: "에스엠", market: "KOSDAQ", prevClose: 92400 },
];

export function findStock(code: string): StockSeed | undefined {
  return UNIVERSE.find((s) => s.code === code);
}
