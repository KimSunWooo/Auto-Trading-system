/**
 * Query / alias normalization for instrument search.
 * - Unicode NFKC
 * - trim + collapse internal whitespace
 * - English letters folded to lowercase for case-insensitive match
 * - Keep ticker punctuation such as BRK.B (dots/hyphens)
 */

const WHITESPACE_RE = /\s+/g;

export function normalizeInstrumentText(value: unknown): string {
  const raw = String(value ?? "");
  const nfkc = raw.normalize("NFKC");
  const trimmed = nfkc.trim().replace(WHITESPACE_RE, " ");
  return foldEnglishCase(trimmed);
}

/** Fold A–Z only; leave non-Latin scripts and punctuation untouched. */
export function foldEnglishCase(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) out += String.fromCodePoint(code + 0x20);
    else out += ch;
  }
  return out;
}

/** Symbol normalization: NFKC, trim, collapse spaces, EN lower; keep `.` and `-`. */
export function normalizeSymbol(value: unknown): string {
  const text = normalizeInstrumentText(value);
  // Strip spaces inside symbols (e.g. "BRK . B" → keep punctuation form from source).
  return text.replace(/\s+/g, "");
}

export function normalizeAlias(value: unknown): string {
  return normalizeInstrumentText(value);
}
