/**
 * NASDAQ Trader Symbol Directory listings.
 * nasdaqlisted.txt → NASDAQ
 * otherlisted.txt Exchange: N=NYSE, A=AMEX (NYSE American). Other venues skipped.
 */
import { baseRow, type ParsedMasterRow } from "@/src/instruments/parsers/common";

export function parseNasdaqListed(text: string): ParsedMasterRow[] {
  return parsePipeListing(text, {
    symbolIdx: 0,
    nameIdx: 1,
    etfIdx: 6,
    testIdx: 3,
    forcedMarket: "NASDAQ",
  });
}

export function parseOtherListed(text: string): {
  nyse: ParsedMasterRow[];
  amex: ParsedMasterRow[];
} {
  const nyse: ParsedMasterRow[] = [];
  const amex: ParsedMasterRow[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { nyse, amex };
  const start = /act\s*symbol|symbol/i.test(lines[0]!) ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/file creation/i.test(line)) continue;
    const cells = line.split("|");
    const symbol = (cells[0] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    if (!symbol || !/^[A-Z0-9][A-Z0-9.\-]*$/.test(symbol)) continue;
    const testIssue = (cells[6] ?? "").trim().toUpperCase();
    if (testIssue === "Y") continue;
    const name = (cells[1] ?? symbol).trim() || symbol;
    const exch = (cells[2] ?? "").trim().toUpperCase();
    const etfFlag = (cells[4] ?? "").trim().toUpperCase();
    const instrumentType = etfFlag === "Y" ? "ETF" : "STOCK";
    if (exch === "N") {
      nyse.push(
        baseRow("US", "NYSE", symbol, name, {
          englishName: name,
          currency: "USD",
          instrumentType,
          aliases: name !== symbol ? [{ alias: name, aliasType: "ENGLISH_NAME" }] : [],
        }),
      );
    } else if (exch === "A") {
      amex.push(
        baseRow("US", "AMEX", symbol, name, {
          englishName: name,
          currency: "USD",
          instrumentType,
          aliases: name !== symbol ? [{ alias: name, aliasType: "ENGLISH_NAME" }] : [],
        }),
      );
    }
  }
  return { nyse, amex };
}

function parsePipeListing(
  text: string,
  opts: {
    symbolIdx: number;
    nameIdx: number;
    etfIdx: number;
    testIdx: number;
    forcedMarket: "NASDAQ" | "NYSE" | "AMEX";
  },
): ParsedMasterRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const start = /symbol/i.test(lines[0]!) ? 1 : 0;
  const rows: ParsedMasterRow[] = [];
  const seen = new Set<string>();
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/file creation/i.test(line)) continue;
    const cells = line.split("|");
    const symbol = (cells[opts.symbolIdx] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    if (!symbol || !/^[A-Z0-9][A-Z0-9.\-]*$/.test(symbol) || seen.has(symbol)) continue;
    const testIssue = (cells[opts.testIdx] ?? "").trim().toUpperCase();
    if (testIssue === "Y") continue;
    const name = (cells[opts.nameIdx] ?? symbol).trim() || symbol;
    const etfFlag = (cells[opts.etfIdx] ?? "").trim().toUpperCase();
    const instrumentType = etfFlag === "Y" || /ETF/i.test(name) ? "ETF" : "STOCK";
    seen.add(symbol);
    rows.push(
      baseRow("US", opts.forcedMarket, symbol, name, {
        englishName: name,
        currency: "USD",
        instrumentType,
        aliases: name !== symbol ? [{ alias: name, aliasType: "ENGLISH_NAME" }] : [],
      }),
    );
  }
  return rows;
}
