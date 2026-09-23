import { baseRow, detectDelimiter, splitFields, splitLines, type ParsedMasterRow } from "./common";

const US_MARKETS = new Set(["NASDAQ", "NYSE", "AMEX"]);

/**
 * US listing CSV / TSV sample.
 *
 * Header:
 *   Symbol,Security Name,Exchange,ETF
 * Body:
 *   AAPL,Apple Inc.,NASDAQ,N
 *   BRK.B,Berkshire Hathaway Inc. Class B,NYSE,N
 */
export function parseUsMaster(text: string, defaultMarket?: string): ParsedMasterRow[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0]!);
  const headerCells = splitFields(lines[0]!, delimiter).map((c) => c.toLowerCase());
  const hasHeader = looksLikeUsHeader(headerCells);
  const start = hasHeader ? 1 : 0;
  const index = hasHeader ? mapUsHeader(headerCells) : defaultUsIndex();
  const forcedMarket = defaultMarket ? String(defaultMarket).toUpperCase() : undefined;

  const rows: ParsedMasterRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitFields(lines[i]!, delimiter);
    const symbolRaw = pick(cells, index.symbol);
    if (!symbolRaw) continue;
    // Keep punctuation (BRK.B); strip spaces only.
    const symbol = symbolRaw.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]*$/.test(symbol) || /^\d{6}$/.test(symbol)) continue;

    const marketRaw = (pick(cells, index.market) || forcedMarket || "NASDAQ").toUpperCase();
    const market = normalizeUsMarket(marketRaw) ?? forcedMarket;
    if (!market || !US_MARKETS.has(market)) continue;

    const englishName = pick(cells, index.name) || symbol;
    const etfFlag = (pick(cells, index.etf) || "").toUpperCase();
    const instrumentType = etfFlag === "Y" || etfFlag === "1" || /ETF/i.test(englishName) ? "ETF" : "STOCK";

    rows.push(
      baseRow("US", market, symbol, englishName, {
        englishName,
        currency: "USD",
        instrumentType,
        aliases: englishName !== symbol ? [{ alias: englishName, aliasType: "ENGLISH_NAME" }] : [],
      }),
    );
  }
  return rows;
}

function looksLikeUsHeader(cells: string[]): boolean {
  const joined = cells.join("|");
  return /symbol|security|name|exchange/.test(joined);
}

function mapUsHeader(cells: string[]): Record<"symbol" | "name" | "market" | "etf", number> {
  const find = (...needles: string[]) =>
    cells.findIndex((cell) => needles.some((n) => cell.includes(n)));
  return {
    symbol: Math.max(0, find("symbol", "ticker")),
    name: find("security", "name", "company"),
    market: find("exchange", "market", "mic"),
    etf: find("etf", "type"),
  };
}

function defaultUsIndex(): Record<"symbol" | "name" | "market" | "etf", number> {
  return { symbol: 0, name: 1, market: 2, etf: 3 };
}

function normalizeUsMarket(raw: string): string | null {
  const u = raw.toUpperCase().replace(/\s+/g, "");
  if (u === "NAS" || u === "NASD" || u === "XNAS" || u.includes("NASDAQ")) return "NASDAQ";
  if (u === "NYS" || u === "XNYS" || u.includes("NYSE")) return "NYSE";
  if (u === "AMS" || u === "XASE" || u.includes("AMEX") || u === "NYSEAMERICAN") return "AMEX";
  if (US_MARKETS.has(u)) return u;
  return null;
}

function pick(cells: string[], index: number): string | undefined {
  if (index < 0 || index >= cells.length) return undefined;
  const value = cells[index]?.trim();
  return value || undefined;
}
