/** Overseas LIMIT price serialization — avoid JS float noise in OVRS_ORD_UNPR. */

const MAX_OVERSEAS_PRICE_DECIMALS = 4;

/**
 * Normalize a US equity limit price for KIS body serialization.
 * Does not invent exchange tick rules; only guarantees finite, >0, trimmed decimals.
 */
export function normalizeOverseasLimitPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("해외 지정가 가격이 올바르지 않습니다.");
  }
  const rounded = Number(price.toFixed(MAX_OVERSEAS_PRICE_DECIMALS));
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new Error("해외 지정가 가격 정규화에 실패했습니다.");
  }
  // Trim trailing zeros but keep at least one decimal place when fractional.
  let text = rounded.toFixed(MAX_OVERSEAS_PRICE_DECIMALS);
  if (text.includes(".")) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (!text || Number(text) <= 0) {
    throw new Error("해외 지정가 가격 직렬화가 비어 있습니다.");
  }
  return text;
}

export function parseOverseasLimitPrice(price: number): number {
  return Number(normalizeOverseasLimitPrice(price));
}
