import { krwEquivalent, usdKrwPair, type ForeignCashBalance, type FxQuote } from "@/src/markets/overseas/fx";
import {
  makeUsInstrument,
  overseasIdentity,
  tradingExcgToExchange,
  type OverseasInstrument,
  type UsExchange,
} from "@/src/markets/overseas/instruments";
import type {
  OverseasBuyingPower,
  OverseasExecution,
  OverseasOpenOrder,
  OverseasPosition,
  OverseasQuote,
} from "@/src/markets/overseas/types";

export function asKisNumber(value: unknown): number {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return undefined;
}

function pickStr(row: Record<string, unknown>, ...keys: string[]): string {
  return String(pick(row, ...keys) ?? "").trim();
}

function asRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object") return [raw as Record<string, unknown>];
  return [];
}

export function usMarketStatus(
  now = new Date(),
  orderable?: string,
): OverseasQuote["marketStatus"] {
  const flag = String(orderable ?? "").trim().toUpperCase();
  if (flag === "YES" || flag === "Y") return "open";
  if (flag === "NO" || flag === "N") return "closed";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = map.weekday;
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "open";
  return "closed";
}

/** Official HHDFS00000300 output. last/base/rate/diff/curr. */
export function mapOverseasPrice(
  row: Record<string, unknown>,
  instrument: OverseasInstrument,
  timestamp = new Date().toISOString(),
): OverseasQuote | null {
  const price = asKisNumber(pick(row, "last", "LAST", "ovrs_nmix_prpr"));
  if (price <= 0) return null;
  const prevClose = asKisNumber(pick(row, "base", "BASE", "ovrs_nmix_prdy_clpr")) || price;
  const change = asKisNumber(pick(row, "diff", "DIFF", "tdiff")) || price - prevClose;
  const changeRate = asKisNumber(pick(row, "rate", "RATE", "prdy_ctrt"));
  const orderableRaw = pickStr(row, "ordy", "ORDY", "e_ordyn");
  const name = pickStr(row, "ename", "ENAME", "name", "rsym") || instrument.displayName;
  const status = usMarketStatus(new Date(timestamp), orderableRaw);
  return {
    identity: overseasIdentity(instrument.exchange, instrument.symbol),
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    displayName: name || instrument.symbol,
    currency: "USD",
    price,
    prevClose,
    change,
    changeRate,
    open: asKisNumber(pick(row, "open", "OPEN")) || price,
    high: asKisNumber(pick(row, "high", "HIGH")) || price,
    low: asKisNumber(pick(row, "low", "LOW")) || price,
    volume: asKisNumber(pick(row, "tvol", "TVOL")),
    timestamp,
    source: "kis",
    orderable: orderableRaw ? /^(YES|Y)$/i.test(orderableRaw) : null,
    marketStatus: status,
  };
}

export function mapSearchInfo(row: Record<string, unknown>, fallback: OverseasInstrument): OverseasInstrument {
  const name = pickStr(row, "prdt_name", "prdt_eng_name", "hts_kor_isnm", "ovrs_item_name");
  const exch =
    tradingExcgToExchange(pickStr(row, "ovrs_excg_cd", "tr_mket_cd", "excg_dvsn_cd")) ?? fallback.exchange;
  return makeUsInstrument(exch, fallback.symbol, name || fallback.displayName);
}

export function mapOverseasHolding(
  row: Record<string, unknown>,
  fxRate: number | null,
): OverseasPosition | null {
  const symbol = pickStr(row, "ovrs_pdno", "pdno", "PDNO", "item_cd").toUpperCase();
  const exchRaw = pickStr(row, "ovrs_excg_cd", "OVRS_EXCG_CD", "tr_mket_cd");
  const exchange = tradingExcgToExchange(exchRaw) ?? "NASDAQ";
  const qty = asKisNumber(pick(row, "ovrs_cblc_qty", "hldg_qty", "cblc_qty13"));
  if (!symbol || qty <= 0) return null;
  const instrument = makeUsInstrument(
    exchange,
    symbol,
    pickStr(row, "ovrs_item_name", "prdt_name", "hts_kor_isnm") || symbol,
  );
  const last = asKisNumber(pick(row, "now_pric2", "ovrs_now_pric1", "last"));
  const avgPrice = asKisNumber(pick(row, "pchs_avg_pric", "avg_unpr3", "pchs_avg_unpr"));
  const marketValue = asKisNumber(pick(row, "frcr_evlu_amt", "ovrs_stck_evlu_amt")) || qty * last;
  const currency = pickStr(row, "tr_crcy_cd", "crcy_cd") || "USD";
  return {
    identity: overseasIdentity(instrument.exchange, instrument.symbol),
    instrument,
    qty,
    avgPrice,
    last,
    marketValue,
    currency,
    krwEquivalent: krwEquivalent(marketValue, fxRate),
  };
}

export function mapForeignCashRows(
  rows: unknown,
  fxFallback: number | null,
): { cash: ForeignCashBalance[]; fx: FxQuote | null } {
  const cash: ForeignCashBalance[] = [];
  let fx: FxQuote | null = null;
  for (const row of asRows(rows)) {
    const currency = pickStr(row, "crcy_cd", "CRCY_CD", "tr_crcy_cd", "natn_cd") || "USD";
    if (!/^[A-Z]{3}$/.test(currency) && currency !== "USD") continue;
    const code = currency === "840" ? "USD" : currency;
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const amount = asKisNumber(
      pick(row, "frcr_dncl_amt", "frcr_cblc_amt", "frcr_evlu_amt", "ovrs_stck_evlu_amt1"),
    );
    const orderable = asKisNumber(
      pick(row, "frcr_ord_psbl_amt1", "ord_psbl_frcr_amt", "frcr_grant_amt", "ovrs_ord_psbl_amt"),
    );
    const rate = asKisNumber(pick(row, "frst_bltn_exrt", "bass_exrt", "fx_rate", "exrt"));
    const fxRate = rate > 0 ? rate : fxFallback;
    if (code === "USD" && fxRate && fxRate > 0) {
      fx = usdKrwPair(fxRate);
    }
    cash.push({
      currency: code,
      cash: amount,
      orderableCash: orderable || amount,
      exchangeRate: fxRate && fxRate > 0 ? fxRate : null,
      krwEquivalent: krwEquivalent(amount, fxRate),
    });
  }
  return { cash, fx };
}

export function mapPsamount(
  row: Record<string, unknown>,
  instrument: OverseasInstrument,
): OverseasBuyingPower {
  return {
    currency: "USD",
    orderableCash: asKisNumber(pick(row, "ovrs_ord_psbl_amt", "frcr_ord_psbl_amt1", "max_ord_psbl_amt")),
    orderableQty: asKisNumber(pick(row, "ovrs_ord_psbl_qty", "max_ord_psbl_qty")),
    exchange: instrument.exchange,
    symbol: instrument.symbol,
  };
}

function mapWorkingOrder(
  row: Record<string, unknown>,
  fallbackExchange: UsExchange = "NASDAQ",
): { orderNo: string; identity: string; symbol: string; exchange: UsExchange; side: "buy" | "sell"; qty: number; filledQty: number; remainingQty: number; price: number; avgPrice: number; currency: string } | null {
  const orderNo = pickStr(row, "odno", "ODNO", "orgn_odno");
  const symbol = pickStr(row, "pdno", "PDNO", "ovrs_pdno").toUpperCase();
  if (!orderNo || !symbol) return null;
  const exchange = tradingExcgToExchange(pickStr(row, "ovrs_excg_cd", "OVRS_EXCG_CD")) ?? fallbackExchange;
  const sll = pickStr(row, "sll_buy_dvsn_cd", "SLL_BUY_DVSN_CD", "sll_buy_dvsn");
  const qty = asKisNumber(pick(row, "ft_ord_qty", "ord_qty", "ORD_QTY"));
  const filledQty = asKisNumber(pick(row, "ft_ccld_qty", "ccld_qty", "tot_ccld_qty"));
  const rawRemaining = pick(row, "nccs_qty", "NCCS_QTY", "rmn_qty", "RMN_QTY");
  const remainingQty = rawRemaining === undefined ? Math.max(0, qty - filledQty) : asKisNumber(rawRemaining);
  const price = asKisNumber(pick(row, "ft_ord_unpr3", "ovrs_ord_unpr", "ord_unpr"));
  const avgPrice = asKisNumber(pick(row, "ft_ccld_unpr3", "avg_unpr3", "avg_prvs")) || price;
  return {
    orderNo,
    identity: overseasIdentity(exchange, symbol),
    symbol,
    exchange,
    side: sll === "01" ? "sell" : "buy",
    qty,
    filledQty,
    remainingQty,
    price,
    avgPrice,
    currency: pickStr(row, "tr_crcy_cd", "crcy_cd") || "USD",
  };
}

/** Official inquire-nccs row. ODNO is exact; remaining uses nccs_qty when present. */
export function mapOverseasOpenOrder(row: Record<string, unknown>): OverseasOpenOrder | null {
  const mapped = mapWorkingOrder(row);
  if (!mapped) return null;
  return {
    orderNo: mapped.orderNo,
    identity: mapped.identity,
    symbol: mapped.symbol,
    exchange: mapped.exchange,
    side: mapped.side,
    qty: mapped.qty,
    filledQty: mapped.filledQty,
    remainingQty: mapped.remainingQty,
    price: mapped.price,
    currency: mapped.currency,
  };
}

export function mapOverseasExecution(row: Record<string, unknown>): OverseasExecution | null {
  const mapped = mapWorkingOrder(row);
  if (!mapped) return null;
  return mapped;
}

export function findOpenOrderByOdno(rows: OverseasOpenOrder[], odno: string): OverseasOpenOrder | undefined {
  const want = String(odno ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!want) return undefined;
  return rows.find((row) => String(row.orderNo).replace(/\D/g, "").replace(/^0+/, "") === want);
}
