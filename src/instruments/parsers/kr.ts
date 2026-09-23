import { baseRow, detectDelimiter, splitFields, splitLines, type ParsedMasterRow } from "./common";

const KR_MARKETS = new Set(["KOSPI", "KOSDAQ", "KONEX"]);

/**
 * KRX-style master sample: pipe or TSV.
 *
 * Header (either language):
 *   short_code|isin|korean_name|english_name|market
 *   단축코드|표준코드|한글종목명|영문종목명|시장구분
 *
 * Body example:
 *   005930|KR7005930003|삼성전자|Samsung Electronics|KOSPI
 */
export function parseKrMaster(text: string, defaultMarket?: string): ParsedMasterRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0]!);
  const headerCells = splitFields(lines[0]!, delimiter).map((c) => c.toLowerCase());
  const hasHeader = looksLikeKrHeader(headerCells);
  const start = hasHeader ? 1 : 0;
  const index = hasHeader ? mapKrHeader(headerCells) : defaultKrIndex();

  const forcedMarket = defaultMarket ? String(defaultMarket).toUpperCase() : undefined;
  const rows: ParsedMasterRow[] = [];

  for (let i = start; i < lines.length; i++) {
    const cells = splitFields(lines[i]!, delimiter);
    const symbol = pick(cells, index.symbol)?.replace(/\D/g, "").padStart(6, "0");
    if (!symbol || !/^\d{6}$/.test(symbol) || symbol === "000000") continue;

    const marketRaw = (pick(cells, index.market) || forcedMarket || "KOSPI").toUpperCase();
    const market = normalizeKrMarket(marketRaw) ?? forcedMarket;
    if (!market || !KR_MARKETS.has(market)) continue;

    const koreanName = pick(cells, index.koreanName) || pick(cells, index.displayName) || symbol;
    const englishName = pick(cells, index.englishName) || null;
    const displayName = koreanName || englishName || symbol;
    const aliases: ParsedMasterRow["aliases"] = [];
    if (englishName && englishName !== displayName) {
      aliases.push({ alias: englishName, aliasType: "ENGLISH_NAME" });
    }
    if (koreanName && koreanName !== displayName) {
      aliases.push({ alias: koreanName, aliasType: "KOREAN_NAME" });
    }

    rows.push(
      baseRow("KR", market, symbol, displayName, {
        koreanName,
        englishName,
        currency: "KRW",
        kisExchangeCode: "KRX",
        instrumentType: "STOCK",
        aliases,
      }),
    );
  }
  return rows;
}

function looksLikeKrHeader(cells: string[]): boolean {
  const joined = cells.join("|");
  return /단축|short|symbol|code|종목/.test(joined);
}

function mapKrHeader(cells: string[]): Record<"symbol" | "koreanName" | "englishName" | "market" | "displayName", number> {
  const find = (...needles: string[]) =>
    cells.findIndex((cell) => needles.some((n) => cell.includes(n)));
  return {
    symbol: Math.max(0, find("단축", "short", "symbol", "code")),
    koreanName: find("한글", "korean", "종목명", "name"),
    englishName: find("영문", "english", "eng"),
    market: find("시장", "market", "mic"),
    displayName: find("한글", "korean", "종목명", "name"),
  };
}

function defaultKrIndex(): Record<"symbol" | "koreanName" | "englishName" | "market" | "displayName", number> {
  return { symbol: 0, koreanName: 2, englishName: 3, market: 4, displayName: 2 };
}

function normalizeKrMarket(raw: string): string | null {
  const u = raw.toUpperCase().replace(/\s+/g, "");
  if (u.includes("KOSDAQ") || u === "KQ" || u === "KSQ") return "KOSDAQ";
  if (u.includes("KONEX") || u === "KN") return "KONEX";
  if (u.includes("KOSPI") || u === "KS" || u === "STK" || u === "유가") return "KOSPI";
  if (KR_MARKETS.has(u)) return u;
  return null;
}

function pick(cells: string[], index: number): string | undefined {
  if (index < 0 || index >= cells.length) return undefined;
  const value = cells[index]?.trim();
  return value || undefined;
}
