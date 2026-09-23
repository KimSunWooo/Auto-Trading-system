import {
  automationSupportedFor,
  defaultCurrency,
  defaultKisExchangeCode,
  makeInstrumentKey,
  type InstrumentRef,
} from "@/src/instruments/types";

export type ParsedMasterRow = {
  country: string;
  market: string;
  symbol: string;
  displayName: string;
  koreanName?: string | null;
  englishName?: string | null;
  currency: string;
  kisExchangeCode?: string | null;
  instrumentType: string;
  aliases: Array<{ alias: string; aliasType: string }>;
};

export function parsedToRef(row: ParsedMasterRow, id?: string): InstrumentRef {
  return {
    id,
    instrumentKey: makeInstrumentKey(row.country, row.market, row.symbol),
    country: row.country,
    market: row.market,
    symbol: row.symbol,
    displayName: row.displayName,
    koreanName: row.koreanName ?? null,
    englishName: row.englishName ?? null,
    currency: row.currency,
    instrumentType: row.instrumentType,
    automationSupported: automationSupportedFor(row.country, row.market),
    isActive: true,
    kisExchangeCode: row.kisExchangeCode ?? defaultKisExchangeCode(row.country, row.market),
    aliases: row.aliases.map((a) => a.alias),
  };
}

export function baseRow(
  country: string,
  market: string,
  symbol: string,
  displayName: string,
  extra: Partial<ParsedMasterRow> = {},
): ParsedMasterRow {
  const aliases = extra.aliases ?? [];
  return {
    country: country.toUpperCase(),
    market: market.toUpperCase(),
    symbol: String(symbol).trim(),
    displayName: displayName.trim() || String(symbol).trim(),
    koreanName: extra.koreanName ?? null,
    englishName: extra.englishName ?? null,
    currency: extra.currency ?? defaultCurrency(country),
    kisExchangeCode: extra.kisExchangeCode ?? defaultKisExchangeCode(country, market),
    instrumentType: extra.instrumentType ?? "STOCK",
    aliases,
  };
}

export function splitLines(text: string): string[] {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function detectDelimiter(headerLine: string): "|" | "\t" | "," {
  if (headerLine.includes("|")) return "|";
  if (headerLine.includes("\t")) return "\t";
  return ",";
}

export function splitFields(line: string, delimiter: "|" | "\t" | ","): string[] {
  if (delimiter === ",") {
    return parseCsvLine(line);
  }
  return line.split(delimiter).map((cell) => cell.trim());
}

/** Minimal CSV splitter that respects double-quoted fields. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}
