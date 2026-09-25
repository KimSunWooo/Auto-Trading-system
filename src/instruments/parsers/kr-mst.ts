/**
 * Official KRX-style master (.mst) downloaded as ZIP from Daishin DWS.
 * Layout (CP949): short_code[0:9] isin[9:21] name[21:61] then type flags.
 */
import iconv from "iconv-lite";
import { baseRow, type ParsedMasterRow } from "@/src/instruments/parsers/common";

const KR_MARKETS = new Set(["KOSPI", "KOSDAQ", "KONEX"]);

/** Parse decompressed .mst bytes (CP949 fixed-width). */
export function parseKrMstBinary(
  buffer: Buffer,
  market: "KOSPI" | "KOSDAQ" | "KONEX",
): ParsedMasterRow[] {
  if (!KR_MARKETS.has(market)) throw new Error(`unsupported KR market ${market}`);
  const text = iconv.decode(buffer, "cp949");
  const rows: ParsedMasterRow[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length < 30) continue;
    const shortCode = rawLine.slice(0, 9).trim();
    if (!shortCode) continue;
    // Prefer tradable 6-digit equities; keep alphanumeric short codes (ETN/ELW) as catalog rows.
    const symbol = /^\d{6}$/.test(shortCode)
      ? shortCode
      : shortCode.replace(/\s+/g, "").toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    // Skip obvious garbage
    if (symbol.length < 4 || symbol.length > 12) continue;

    const isin = rawLine.slice(9, 21).trim();
    const nameField = rawLine.slice(21, 61).trim();
    // Name is space-padded; type token (ST/FS/EF/BC…) may leak if trimmed poorly — strip trailing type.
    const displayName = nameField.replace(/\s+(ST|FS|EF|BC|EN|DR)\d*.*$/i, "").trim() || nameField || symbol;
    const typeTok = rawLine.slice(61, 63).trim().toUpperCase() || detectTypeToken(rawLine.slice(21));
    const instrumentType =
      typeTok === "EF" || /ETF/i.test(displayName)
        ? "ETF"
        : typeTok === "EN" || typeTok === "BC"
          ? "FUND"
          : "STOCK";

    seen.add(symbol);
    rows.push(
      baseRow("KR", market, symbol, displayName, {
        koreanName: displayName,
        englishName: null,
        currency: "KRW",
        kisExchangeCode: "KRX",
        instrumentType,
        // Adopted RDS ck_instrument_alias_type: SYMBOL|KOREAN|ENGLISH|SEARCH
        aliases: isin ? [{ alias: isin, aliasType: "SEARCH" }] : [],
      }),
    );
  }
  return rows;
}

function detectTypeToken(fromName: string): string {
  const m = fromName.match(/\s(ST|FS|EF|BC|EN)\b/);
  return m?.[1]?.toUpperCase() ?? "ST";
}
