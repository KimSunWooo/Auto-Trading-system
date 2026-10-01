/**
 * Instrument name resolution without N+1 KIS REST calls.
 * Prefer: hint name → in-memory cache → UNIVERSE seed. Never invent names.
 */
import { findStock } from "@/lib/universe";

export type InstrumentMetadata = {
  symbol: string;
  name: string | null;
  market?: string;
};

const NAME_CACHE = new Map<string, InstrumentMetadata>();

function normalizeSymbol(symbol: string): string {
  const raw = String(symbol ?? "").trim();
  if (/^\d{1,6}$/.test(raw)) return raw.padStart(6, "0");
  return raw;
}

export function resolveInstrumentMetadata(
  symbol: string,
  hintName?: string | null,
): InstrumentMetadata {
  const code = normalizeSymbol(symbol);
  const hint = hintName?.trim() || null;
  const usableHint = hint && hint !== code ? hint : null;

  const cached = NAME_CACHE.get(code);
  if (cached?.name) {
    if (usableHint && usableHint !== cached.name) {
      const next = { ...cached, name: usableHint };
      NAME_CACHE.set(code, next);
      return next;
    }
    return cached;
  }

  const seed = findStock(code);
  const name = usableHint ?? seed?.name ?? null;
  const meta: InstrumentMetadata = {
    symbol: code,
    name,
    market: seed?.market,
  };
  if (name) NAME_CACHE.set(code, meta);
  return meta;
}

/** "삼성전자 (005930)" or fallback to symbol only. */
export function formatInstrumentLabel(
  symbol: string,
  hintName?: string | null,
): string {
  const meta = resolveInstrumentMetadata(symbol, hintName);
  if (meta.name) return `${meta.name} (${meta.symbol})`;
  return meta.symbol;
}

export function instrumentNameOnly(
  symbol: string,
  hintName?: string | null,
): string {
  return resolveInstrumentMetadata(symbol, hintName).name ?? normalizeSymbol(symbol);
}

export function resetInstrumentNameCacheForTest() {
  NAME_CACHE.clear();
}

export function instrumentNameCacheSizeForTest(): number {
  return NAME_CACHE.size;
}
