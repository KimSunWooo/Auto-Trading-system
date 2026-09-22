/**
 * Official KIS H0STCNT0 (국내주식 실시간체결가 KRX) column order.
 * Source: koreainvestment/open-trading-api examples_user/domestic_stock_functions_ws.py ccnl_krx.
 * Do not invent or reorder columns.
 *
 * Subscribe/unsubscribe tr_type (official KISWebSocket in kis_auth.py):
 *   subscribe   = "1"
 *   unsubscribe = "2"
 * (ccnl_krx docstring saying "0" is outdated; unsubscribe() sends "2".)
 */
export const H0STCNT0_TR_ID = "H0STCNT0" as const;

/** Official PAPER WS path suffix used by KISWebSocket(api_url="/tryitout"). */
export const KIS_PAPER_WS_PATH = "/tryitout" as const;

/** Max realtime registrations per WebSocket session (KIS official: 합산 최대 41). */
export const KIS_WS_SUBSCRIPTION_LIMIT = 41;

/** Official subscribe / unsubscribe tr_type values. */
export const KIS_WS_TR_TYPE = {
  subscribe: "1",
  unsubscribe: "2",
} as const;

/**
 * Official PRICE_COLUMNS for H0STCNT0 realtime pipe/^ payload.
 * Index 0 = MKSC_SHRN_ISCD … last = VI_STND_PRC.
 */
export const H0STCNT0_COLUMNS = [
  "MKSC_SHRN_ISCD",
  "STCK_CNTG_HOUR",
  "STCK_PRPR",
  "PRDY_VRSS_SIGN",
  "PRDY_VRSS",
  "PRDY_CTRT",
  "WGHN_AVRG_STCK_PRC",
  "STCK_OPRC",
  "STCK_HGPR",
  "STCK_LWPR",
  "ASKP1",
  "BIDP1",
  "CNTG_VOL",
  "ACML_VOL",
  "ACML_TR_PBMN",
  "SELN_CNTG_CSNU",
  "SHNU_CNTG_CSNU",
  "NTBY_CNTG_CSNU",
  "CTTR",
  "SELN_CNTG_SMTN",
  "SHNU_CNTG_SMTN",
  "CCLD_DVSN",
  "SHNU_RATE",
  "PRDY_VOL_VRSS_ACML_VOL_RATE",
  "OPRC_HOUR",
  "OPRC_VRSS_PRPR_SIGN",
  "OPRC_VRSS_PRPR",
  "HGPR_HOUR",
  "HGPR_VRSS_PRPR_SIGN",
  "HGPR_VRSS_PRPR",
  "LWPR_HOUR",
  "LWPR_VRSS_PRPR_SIGN",
  "LWPR_VRSS_PRPR",
  "BSOP_DATE",
  "NEW_MKOP_CLS_CODE",
  "TRHT_YN",
  "ASKP_RSQN1",
  "BIDP_RSQN1",
  "TOTAL_ASKP_RSQN",
  "TOTAL_BIDP_RSQN",
  "VOL_TNRT",
  "PRDY_SMNS_HOUR_ACML_VOL",
  "PRDY_SMNS_HOUR_ACML_VOL_RATE",
  "HOUR_CLS_CODE",
  "MRKT_TRTM_CLS_CODE",
  "VI_STND_PRC",
] as const;

export type H0stCnt0Column = (typeof H0STCNT0_COLUMNS)[number];

export const H0STCNT0_FIELD_WIDTH = H0STCNT0_COLUMNS.length;

const COL_INDEX: Record<H0stCnt0Column, number> = H0STCNT0_COLUMNS.reduce(
  (acc, name, i) => {
    acc[name] = i;
    return acc;
  },
  {} as Record<H0stCnt0Column, number>,
);

export type ParsedH0stCnt0 = {
  ticker: string;
  tradeTime: string;
  price: number;
  open: number;
  high: number;
  low: number;
  ask: number;
  bid: number;
  /** Per-trade volume (CNTG_VOL). */
  tradeVolume: number;
  /** Cumulative volume (ACML_VOL) — used as Quote.volume. */
  volume: number;
  businessDate: string;
  /** Raw field map for diagnostics (no secrets). */
  fields: Partial<Record<H0stCnt0Column, string>>;
};

export type H0stCnt0BatchParse = {
  rows: ParsedH0stCnt0[];
  /** data_cnt from the frame header (best effort). */
  expectedCount: number;
  /** Rows that could not be parsed (incomplete remainder / invalid price). */
  malformedRows: number;
};

function asNumber(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function field(parts: string[], name: H0stCnt0Column): string {
  return parts[COL_INDEX[name]] ?? "";
}

function parseRowFields(parts: string[]): ParsedH0stCnt0 | null {
  // Require at least through ACML_VOL so OHLC/bid/ask/volume are present.
  if (parts.length <= COL_INDEX.ACML_VOL) return null;

  const ticker = field(parts, "MKSC_SHRN_ISCD").trim();
  const price = asNumber(field(parts, "STCK_PRPR"));
  if (!ticker || !(price > 0)) return null;

  const open = asNumber(field(parts, "STCK_OPRC")) || price;
  const high = asNumber(field(parts, "STCK_HGPR")) || price;
  const low = asNumber(field(parts, "STCK_LWPR")) || price;
  const ask = asNumber(field(parts, "ASKP1"));
  const bid = asNumber(field(parts, "BIDP1"));
  const tradeVolume = asNumber(field(parts, "CNTG_VOL"));
  const volume = asNumber(field(parts, "ACML_VOL"));

  const fields: Partial<Record<H0stCnt0Column, string>> = {};
  for (const name of H0STCNT0_COLUMNS) {
    const v = field(parts, name);
    if (v !== "") fields[name] = v;
  }

  return {
    ticker,
    tradeTime: field(parts, "STCK_CNTG_HOUR"),
    price,
    open,
    high,
    low,
    ask: ask > 0 ? ask : price,
    bid: bid > 0 ? bid : price,
    tradeVolume,
    volume,
    businessDate: field(parts, "BSOP_DATE"),
    fields,
  };
}

/**
 * Parse all rows in a KIS realtime frame:
 *   0|H0STCNT0|{data_cnt}|{caret-separated fields × data_cnt}
 * Incomplete trailing remainder is ignored (malformedRows++), never mixed into another row.
 */
export function parseH0stCnt0RealtimeBatch(raw: string): H0stCnt0BatchParse {
  const empty: H0stCnt0BatchParse = { rows: [], expectedCount: 0, malformedRows: 0 };
  const text = String(raw ?? "").trim();
  if (!text || text.startsWith("{")) return empty;

  const segments = text.split("|");
  if (segments.length < 4) return empty;
  const trId = segments[1];
  if (trId !== H0STCNT0_TR_ID) return empty;

  const cntRaw = Number(String(segments[2] ?? "").trim());
  const expectedCount =
    Number.isFinite(cntRaw) && cntRaw > 0 ? Math.floor(cntRaw) : 1;

  const payload = segments.slice(3).join("|");
  const parts = payload.split("^");

  const rows: ParsedH0stCnt0[] = [];
  let malformedRows = 0;

  for (let i = 0; i < expectedCount; i++) {
    const start = i * H0STCNT0_FIELD_WIDTH;
    const end = start + H0STCNT0_FIELD_WIDTH;
    if (start >= parts.length) {
      malformedRows += expectedCount - i;
      break;
    }
    // Prefer full-width slice; allow slightly short last fields if still past ACML_VOL.
    const slice =
      end <= parts.length
        ? parts.slice(start, end)
        : parts.slice(start);
    if (slice.length <= COL_INDEX.ACML_VOL) {
      malformedRows += 1;
      continue;
    }
    // Pad missing trailing empties so field() indexes stay aligned.
    while (slice.length < H0STCNT0_FIELD_WIDTH) slice.push("");
    const row = parseRowFields(slice);
    if (!row) {
      malformedRows += 1;
      continue;
    }
    rows.push(row);
  }

  // Extra caret fields beyond expectedCount * width are ignored (do not invent rows).
  return { rows, expectedCount, malformedRows };
}

/**
 * Compatibility wrapper — first valid row only.
 * Prefer parseH0stCnt0RealtimeBatch for multi-row frames.
 */
export function parseH0stCnt0Realtime(raw: string): ParsedH0stCnt0 | null {
  return parseH0stCnt0RealtimeBatch(raw).rows[0] ?? null;
}

export type KisWsSystemMessage = {
  trId: string;
  trKey?: string;
  isOk: boolean;
  isPingPong: boolean;
  isUnSub: boolean;
  message?: string;
  encrypt?: string;
};

/** Parse KIS WebSocket SYSTEM JSON (subscribe ack / PINGPONG / errors). */
export function parseKisWsSystemMessage(raw: string): KisWsSystemMessage | null {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    header?: { tr_id?: string; tr_key?: string; encrypt?: string };
    body?: { rt_cd?: string; msg1?: string; msg_cd?: string };
  };
  const trId = String(obj.header?.tr_id ?? "");
  if (!trId) return null;
  const isPingPong = trId === "PINGPONG";
  const msg1 = obj.body?.msg1 != null ? String(obj.body.msg1) : undefined;
  return {
    trId,
    trKey: obj.header?.tr_key != null ? String(obj.header.tr_key) : undefined,
    isOk: isPingPong ? true : String(obj.body?.rt_cd ?? "") === "0",
    isPingPong,
    isUnSub: Boolean(msg1 && msg1.slice(0, 5) === "UNSUB"),
    message: msg1,
    encrypt: obj.header?.encrypt != null ? String(obj.header.encrypt) : undefined,
  };
}

/** Build official subscribe/unsubscribe frame. tr_type "1"=sub, "2"=unsub. */
export function buildH0stCnt0SubscribeMessage(opts: {
  approvalKey: string;
  ticker: string;
  trType: "1" | "2";
}): string {
  return JSON.stringify({
    header: {
      approval_key: opts.approvalKey,
      custtype: "P",
      tr_type: opts.trType,
      "content-type": "utf-8",
    },
    body: {
      input: {
        tr_id: H0STCNT0_TR_ID,
        tr_key: opts.ticker,
      },
    },
  });
}
