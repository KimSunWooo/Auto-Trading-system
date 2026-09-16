import {
  KIS_TR,
  loadKisConfig,
  resolveKisEnvironment,
  type KisConfig,
  type KisEnvironment,
  type KisMode,
} from "@/src/brokers/kis-config";
import { HARD_LIMITS } from "@/src/risk/limits";
import { BrokerRejectError, IndeterminateOrderError } from "@/src/risk/errors";
import { allowLiveTrading, realKisOrdersLocked, tradingMode } from "@/src/runtime/trading-mode";

export type KisPrice = {
  ticker: string;
  name: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
};

export type KisCashOrder = {
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  ordDvsn: "market" | "limit";
  price: number;
};

export type KisDayOrder = {
  orderNo: string;
  ticker: string;
  side: "buy" | "sell";
  qty: number;
  filledQty: number;
  unfilledQty: number;
  avgPrice: number;
  /** Official `ord_unpr`. */
  orderPrice?: number;
  /** Official `ord_dt` YYYYMMDD. */
  ordDt?: string;
  /** Official `ord_tmd`. */
  ordTmd?: string;
  /** Official `cncl_yn`. Y/N when present. */
  cnclYn?: string;
};

export type KisCcldDvsn = "00" | "01" | "02";

export type KisCancelOrder = {
  orderNo: string;
  krxOrgNo: string;
  ordDvsn: "market" | "limit";
};

export type KisHolding = {
  ticker: string;
  name: string;
  qty: number;
  avgPrice: number;
};

export type KisAccountBalance = {
  cash: number;
  d2Cash: number;
  holdings: KisHolding[];
};

export interface KisApi {
  readonly mode: KisMode;
  readonly configured: boolean;
  readonly liveEnabled: boolean;
  readonly issues: string[];
  readonly cano?: string;
  inquirePrice(ticker: string): Promise<KisPrice>;
  inquireDailyCloses(ticker: string): Promise<number[]>;
  inquireDailyCcld(): Promise<KisDayOrder[]>;
  inquireOpenOrders(): Promise<KisDayOrder[]>;
  inquireBalance(): Promise<KisAccountBalance>;
  orderCash(order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }>;
  cancelOrder(order: KisCancelOrder): Promise<void>;
}

/** Strip punctuation/leading zeros so "0000000123" matches "123". */
export function sameOdno(a: string | undefined, b: string | undefined): boolean {
  const na = String(a ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const nb = String(b ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return na.length > 0 && na === nb;
}

export function padOdno(value: string | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.padStart(10, "0").slice(-10);
}

type FetchLike = typeof fetch;

type TokenCache = { access: string; expiresAt: number };

function asNumber(value: unknown): number {
  const n = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function pickQty(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return row[key];
    }
  }
  return undefined;
}

/** Map official inquire-daily-ccld output1 row. Does not invent missing KIS fields. */
export function mapKisDailyCcldRow(row: Record<string, unknown>): KisDayOrder | null {
  const orderNo = String(row.odno ?? row.ODNO ?? "").trim();
  const rawTicker = String(row.pdno ?? row.PDNO ?? "").replace(/\D/g, "").slice(-6);
  const ticker = rawTicker.padStart(6, "0");
  if (!orderNo && (!rawTicker || ticker === "000000")) return null;

  const sll = String(row.sll_buy_dvsn_cd ?? row.SLL_BUY_DVSN_CD ?? "");
  const qty = asNumber(row.ord_qty ?? row.ORD_QTY);
  const filledQty = asNumber(row.tot_ccld_qty ?? row.TOT_CCLD_QTY);
  const rawRemaining = pickQty(row, "rmn_qty", "RMN_QTY", "nccs_qty", "NCCS_QTY");
  const unfilledQty =
    rawRemaining === undefined ? Math.max(0, qty - filledQty) : asNumber(rawRemaining);
  const cnclYn = String(row.cncl_yn ?? row.CNCL_YN ?? "").trim();
  const ordDt = String(row.ord_dt ?? row.ORD_DT ?? "").trim();
  const ordTmd = String(row.ord_tmd ?? row.ORD_TMD ?? "").trim();
  const rawPrice = pickQty(row, "ord_unpr", "ORD_UNPR");

  return {
    orderNo,
    ticker,
    side: sll === "01" ? "sell" : "buy",
    qty,
    filledQty,
    unfilledQty,
    avgPrice: asNumber(row.avg_prvs ?? row.AVG_PRVS) || asNumber(row.avg_ccld_unpr),
    orderPrice: rawPrice === undefined ? undefined : asNumber(rawPrice),
    ordDt: ordDt || undefined,
    ordTmd: ordTmd || undefined,
    cnclYn: cnclYn || undefined,
  };
}

function yyyymmddSeoul(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts.replaceAll("-", "");
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

const ACCESS_TOKENS = new Map<string, TokenCache>();

export class KisClient implements KisApi {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly priceCache = new Map<string, { at: number; value: KisPrice }>();
  private readonly dailyCache = new Map<string, { at: number; value: number[] }>();

  constructor(
    private readonly config: KisConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly maxConcurrent = 6,
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): KisClient {
    return new KisClient(loadKisConfig(env));
  }

  get mode(): KisMode {
    return this.config.environment;
  }

  get environment(): KisEnvironment {
    return this.config.environment;
  }

  get cano(): string {
    return this.config.cano;
  }

  get host(): string {
    return this.config.host;
  }

  get tokenCacheKey(): string {
    return this.config.tokenCacheKey;
  }

  get configured(): boolean {
    return this.config.configured;
  }

  get liveEnabled(): boolean {
    return this.config.liveEnabled;
  }

  get issues(): string[] {
    return this.config.issues;
  }

  async inquirePrice(ticker: string): Promise<KisPrice> {
    this.assertConfigured();
    const cached = this.priceCache.get(ticker);
    if (cached && Date.now() - cached.at < 1_000) return cached.value;

    const json = await this.uapi(
      "GET",
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      {
        trId: KIS_TR.price,
        query: {
          FID_COND_MRKT_DIV_CODE: "J",
          FID_INPUT_ISCD: ticker,
        },
      },
    );
    const out = (json.output ?? json.output1 ?? {}) as Record<string, unknown>;
    const price = asNumber(out.stck_prpr);
    if (price <= 0) {
      throw new Error(`${ticker} 현재가를 받지 못했습니다.`);
    }
    const value: KisPrice = {
      ticker,
      name: String(out.hts_kor_isnm ?? "").trim(),
      price,
      open: asNumber(out.stck_oprc) || price,
      high: asNumber(out.stck_hgpr) || price,
      low: asNumber(out.stck_lwpr) || price,
      prevClose: asNumber(out.stck_sdpr) || asNumber(out.stck_prdy_clpr) || price,
      volume: asNumber(out.acml_vol),
    };
    this.priceCache.set(ticker, { at: Date.now(), value });
    return value;
  }

  async inquireDailyCloses(ticker: string): Promise<number[]> {
    this.assertConfigured();
    const cached = this.dailyCache.get(ticker);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;

    const end = new Date();
    const start = addDays(end, -90);
    try {
      const json = await this.uapi(
        "GET",
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        {
          trId: KIS_TR.daily,
          query: {
            FID_COND_MRKT_DIV_CODE: "J",
            FID_INPUT_ISCD: ticker,
            FID_INPUT_DATE_1: yyyymmddSeoul(start),
            FID_INPUT_DATE_2: yyyymmddSeoul(end),
            FID_PERIOD_DIV_CODE: "D",
            FID_ORG_ADJ_PRC: "1",
          },
        },
      );
      const raw = json.output2 ?? json.output;
      const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const closes = rows
        .map((row) => asNumber(row.stck_clpr))
        .filter((n) => n > 0)
        .reverse();
      this.dailyCache.set(ticker, { at: Date.now(), value: closes });
      return closes;
    } catch {
      return [];
    }
  }

  async orderCash(order: KisCashOrder): Promise<{ orderNo: string; krxOrgNo: string }> {
    this.assertConfigured();
    this.assertRealOrdersAllowed();
    if (order.qty < 1) {
      throw new Error("주문 수량이 1주 미만입니다.");
    }

    const body = {
      CANO: this.config.cano,
      ACNT_PRDT_CD: this.config.productCode,
      PDNO: order.ticker,
      ORD_DVSN: order.ordDvsn === "market" ? "01" : "00",
      ORD_QTY: String(order.qty),
      ORD_UNPR: order.ordDvsn === "market" ? "0" : String(order.price),
    };
    const hashkey = await this.hashkey(body);
    const trId =
      order.side === "buy" ? KIS_TR.buy[this.config.mode] : KIS_TR.sell[this.config.mode];
    const json = await this.uapi("POST", "/uapi/domestic-stock/v1/trading/order-cash", {
      trId,
      hashkey,
      body,
      timeoutMs: HARD_LIMITS.orderTimeoutMs,
      kind: "order",
    });
    const out = (json.output ?? {}) as Record<string, unknown>;
    const orderNo = String(out.ODNO ?? json.odno ?? "").trim();
    if (!orderNo) {
      throw new IndeterminateOrderError("KIS가 주문번호를 반환하지 않았습니다. 체결 여부를 확인해야 합니다.");
    }
    const krxOrgNo = String(
      out.KRX_FWDG_ORD_ORGNO ?? out.krx_fwdg_ord_orgno ?? "",
    ).trim();
    return { orderNo, krxOrgNo };
  }

  async cancelOrder(order: KisCancelOrder): Promise<void> {
    this.assertConfigured();
    this.assertRealOrdersAllowed();
    const body = {
      CANO: this.config.cano,
      ACNT_PRDT_CD: this.config.productCode,
      KRX_FWDG_ORD_ORGNO: order.krxOrgNo,
      ORGN_ODNO: padOdno(order.orderNo),
      ORD_DVSN: order.ordDvsn === "market" ? "01" : "00",
      RVSE_CNCL_DVSN_CD: "02",
      ORD_QTY: "0",
      ORD_UNPR: "0",
      QTY_ALL_ORD_YN: "Y",
      EXCG_ID_DVSN_CD: "KRX",
      CNDT_PRIC: "0",
    };
    const hashkey = await this.hashkey(body);
    await this.uapi("POST", "/uapi/domestic-stock/v1/trading/order-rvsecncl", {
      trId: KIS_TR.cancel[this.config.mode],
      hashkey,
      body,
      timeoutMs: HARD_LIMITS.orderTimeoutMs,
      kind: "order",
    });
  }

  /** Executions: official CCLD_DVSN=01 (체결). */
  async inquireDailyCcld(): Promise<KisDayOrder[]> {
    const rows = await this.inquireDailyCcldRows("01");
    return rows.filter((row) => row.orderNo || row.ticker);
  }

  /** Open orders: official CCLD_DVSN=02 (미체결). Same domestic daily-ccld API. */
  async inquireOpenOrders(): Promise<KisDayOrder[]> {
    const rows = await this.inquireDailyCcldRows("02");
    return rows.filter((row) => row.orderNo);
  }

  private async inquireDailyCcldRows(ccldDvsn: KisCcldDvsn): Promise<KisDayOrder[]> {
    this.assertConfigured();
    const day = yyyymmddSeoul(new Date());
    const json = await this.uapi(
      "GET",
      "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
      {
        trId: KIS_TR.dailyCcld[this.config.mode],
        timeoutMs: HARD_LIMITS.quoteTimeoutMs,
        query: {
          CANO: this.config.cano,
          ACNT_PRDT_CD: this.config.productCode,
          INQR_STRT_DT: day,
          INQR_END_DT: day,
          SLL_BUY_DVSN_CD: "00",
          PDNO: "",
          CCLD_DVSN: ccldDvsn,
          INQR_DVSN: "00",
          INQR_DVSN_3: "00",
          ORD_GNO_BRNO: "",
          ODNO: "",
          INQR_DVSN_1: "",
          EXCG_ID_DVSN_CD: "KRX",
          CTX_AREA_FK100: "",
          CTX_AREA_NK100: "",
        },
      },
    );
    const raw = json.output1 ?? json.output ?? [];
    const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return rows.map((row) => mapKisDailyCcldRow(row)).filter((row): row is KisDayOrder => row !== null);
  }

  async inquireBalance(): Promise<KisAccountBalance> {
    this.assertConfigured();
    const holdings = new Map<string, KisHolding>();
    let cash = 0;
    let d2Cash = 0;
    let fk = "";
    let nk = "";

    for (let page = 0; page < 10; page += 1) {
      const json = await this.uapi(
        "GET",
        "/uapi/domestic-stock/v1/trading/inquire-balance",
        {
          trId: KIS_TR.balance[this.config.mode],
          timeoutMs: HARD_LIMITS.quoteTimeoutMs,
          query: {
            CANO: this.config.cano,
            ACNT_PRDT_CD: this.config.productCode,
            AFHR_FLPR_YN: "N",
            OFL_YN: "",
            INQR_DVSN: "01",
            UNPR_DVSN: "01",
            FUND_STTL_ICLD_YN: "N",
            FNCG_AMT_AUTO_RDPT_YN: "N",
            PRCS_DVSN: "00",
            CTX_AREA_FK100: fk,
            CTX_AREA_NK100: nk,
          },
        },
      );
      const raw1 = json.output1 ?? json.output ?? [];
      const rows = Array.isArray(raw1) ? (raw1 as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const qty = asNumber(row.hldg_qty);
        const ticker = String(row.pdno ?? row.PDNO ?? "").replace(/\D/g, "").slice(-6).padStart(6, "0");
        if (qty < 1 || ticker === "000000") continue;
        const prev = holdings.get(ticker);
        holdings.set(ticker, {
          ticker,
          name: String(row.prdt_name ?? row.hts_kor_isnm ?? prev?.name ?? ticker).trim(),
          qty: (prev?.qty ?? 0) + qty,
          avgPrice: asNumber(row.pchs_avg_pric) || prev?.avgPrice || 0,
        });
      }
      const raw2 = json.output2;
      const summary = (Array.isArray(raw2) ? raw2[0] : raw2) as Record<string, unknown> | undefined;
      if (summary) {
        cash = asNumber(summary.dnca_tot_amt);
        d2Cash = asNumber(summary.prvs_rcdl_excc_amt);
      }
      nk = String(json.ctx_area_nk100 ?? json.CTX_AREA_NK100 ?? "").trim();
      fk = String(json.ctx_area_fk100 ?? json.CTX_AREA_FK100 ?? "").trim();
      if (!nk) break;
    }

    return { cash, d2Cash, holdings: [...holdings.values()] };
  }

  private assertConfigured() {
    if (!this.config.configured) {
      throw new Error(this.config.issues[0] ?? "한국투자증권 Open API 설정이 없습니다.");
    }
  }

  private assertRealOrdersAllowed() {
    if (this.config.mode !== "real") return;
    const locked = realKisOrdersLocked();
    if (locked || tradingMode() !== "live" || !allowLiveTrading() || !this.config.liveEnabled) {
      throw new Error(
        locked ??
          "실전 주문이 잠겨 있습니다. TRADING_MODE=live, ALLOW_LIVE_TRADING=true, KIS_LIVE_CONFIRM=I_UNDERSTAND 가 모두 필요합니다.",
      );
    }
  }

  private async hashkey(orderBody: Record<string, string>): Promise<string> {
    const json = await this.request("POST", `${this.config.host}/uapi/hashkey`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
      },
      body: JSON.stringify(orderBody),
    }, HARD_LIMITS.quoteTimeoutMs);
    const hash = String(json.HASH ?? json.hashkey ?? json.hash ?? "").trim();
    if (!hash) {
      throw new Error("hashkey를 발급받지 못했습니다.");
    }
    return hash;
  }

  private clearAccessToken() {
    ACCESS_TOKENS.delete(this.config.tokenCacheKey);
  }

  private async getAccessToken(): Promise<string> {
    const cacheKey = this.config.tokenCacheKey;
    const cached = ACCESS_TOKENS.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.access;
    }
    const json = await this.request("POST", `${this.config.host}/oauth2/tokenP`, {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
      }),
    }, HARD_LIMITS.quoteTimeoutMs);
    const access = String(json.access_token ?? "").trim();
    if (!access) {
      throw new Error("접근 토큰을 받지 못했습니다. 앱키와 모의/실전 도메인을 확인하세요.");
    }
    const expiresIn = asNumber(json.expires_in) || 86_400;
    ACCESS_TOKENS.set(cacheKey, {
      access,
      expiresAt: Date.now() + Math.max(60, expiresIn - 3_600) * 1000,
    });
    return access;
  }

  private async uapi(
    method: "GET" | "POST",
    path: string,
    opts: {
      trId: string;
      query?: Record<string, string>;
      body?: Record<string, string>;
      hashkey?: string;
      timeoutMs?: number;
      kind?: "query" | "order";
    },
  ) {
    const token = await this.getAccessToken();
    const url = new URL(path, this.config.host);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: this.config.appKey,
      appsecret: this.config.appSecret,
      tr_id: opts.trId,
      custtype: "P",
    };
    if (opts.hashkey) headers.hashkey = opts.hashkey;
    return this.request(
      method,
      url.toString(),
      {
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      },
      opts.timeoutMs ?? HARD_LIMITS.quoteTimeoutMs,
      opts.kind ?? "query",
    );
  }

  private async request(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
    timeoutMs: number,
    kind: "query" | "order" = "query",
  ): Promise<Record<string, unknown>> {
    return this.slot(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: init.headers,
          body: method === "GET" ? undefined : init.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw this.wrapTransportError(err, kind);
      }
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw this.httpFailure(kind, res.status, "KIS 응답이 JSON이 아닙니다.");
      }
      const rt = json.rt_cd;
      const message = String(json.msg1 ?? json.error_description ?? json.msg_cd ?? `KIS HTTP ${res.status}`);
      if (!res.ok) {
        if (String(json.msg_cd ?? "").includes("EGW00123")) this.clearAccessToken();
        throw this.httpFailure(kind, res.status, message);
      }
      if (rt !== undefined && String(rt) !== "0") {
        if (String(json.msg_cd ?? "").includes("EGW00123")) this.clearAccessToken();
        if (kind === "order") throw new BrokerRejectError(message);
        throw new Error(message);
      }
      return json;
    });
  }

  private wrapTransportError(err: unknown, kind: "query" | "order"): Error {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
    const message = err instanceof Error ? err.message : "KIS 네트워크 오류";
    if (kind === "order") {
      return new IndeterminateOrderError(
        name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(message)
          ? "주문 응답 시간 초과. 체결 여부를 확인해야 합니다."
          : `주문 전송 결과를 확인하지 못했습니다. ${message}`,
      );
    }
    return err instanceof Error ? err : new Error(message);
  }

  private httpFailure(kind: "query" | "order", status: number, message: string): Error {
    if (kind !== "order") {
      return new Error(message);
    }
    if (status >= 500 || status === 0) {
      return new IndeterminateOrderError(message);
    }
    if (status >= 400 && status < 500) {
      return new BrokerRejectError(message);
    }
    return new IndeterminateOrderError(message);
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inflight += 1;
    try {
      return await fn();
    } finally {
      this.inflight -= 1;
      this.waiters.shift()?.();
    }
  }
}

const sharedByEnv = new Map<KisEnvironment, KisApi>();
let testOverride: KisApi | null = null;

export function getSharedKisClient(): KisApi {
  if (testOverride) return testOverride;
  const environment = resolveKisEnvironment();
  const existing = sharedByEnv.get(environment);
  if (existing) {
    if (existing.mode !== environment) {
      throw new Error("KIS client environment mismatch. REAL/PAPER token 을 재사용하지 않습니다.");
    }
    return existing;
  }
  const created = KisClient.fromEnv();
  if (created.mode !== environment) {
    throw new Error("KIS client environment mismatch. REAL/PAPER token 을 재사용하지 않습니다.");
  }
  sharedByEnv.set(environment, created);
  return created;
}

export function setSharedKisClientForTest(client: KisApi | null) {
  testOverride = client;
  if (!client) {
    sharedByEnv.clear();
    ACCESS_TOKENS.clear();
  }
}

export function resetSharedKisClient() {
  testOverride = null;
  sharedByEnv.clear();
  ACCESS_TOKENS.clear();
}

export function resetKisTokenCacheForTest() {
  ACCESS_TOKENS.clear();
}
