import {
  KIS_TR,
  loadKisConfig,
  type KisConfig,
  type KisMode,
} from "@/src/brokers/kis-config";
import { HARD_LIMITS } from "@/src/risk/limits";
import { IndeterminateOrderError } from "@/src/risk/errors";

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
};

export type KisCancelOrder = {
  orderNo: string;
  krxOrgNo: string;
  ordDvsn: "market" | "limit";
};

export interface KisApi {
  readonly mode: KisMode;
  readonly configured: boolean;
  readonly liveEnabled: boolean;
  readonly issues: string[];
  inquirePrice(ticker: string): Promise<KisPrice>;
  inquireDailyCloses(ticker: string): Promise<number[]>;
  inquireDailyCcld(): Promise<KisDayOrder[]>;
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

export class KisClient implements KisApi {
  private token: TokenCache | null = null;
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
    return this.config.mode;
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
    if (this.config.mode === "real" && !this.config.liveEnabled) {
      throw new Error(
        "실전 주문이 잠겨 있습니다. KIS_MODE=real 과 KIS_LIVE_CONFIRM=I_UNDERSTAND 를 함께 설정하세요.",
      );
    }
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
    if (this.config.mode === "real" && !this.config.liveEnabled) {
      throw new Error(
        "실전 주문이 잠겨 있습니다. KIS_MODE=real 과 KIS_LIVE_CONFIRM=I_UNDERSTAND 를 함께 설정하세요.",
      );
    }
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
    });
  }

  async inquireDailyCcld(): Promise<KisDayOrder[]> {
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
          INQR_DVSN: "00",
          PDNO: "",
          CCLD_DVSN: "00",
          INQR_DVSN_3: "00",
          INQR_DVSN_1: "",
          CTX_AREA_FK100: "",
          CTX_AREA_NK100: "",
        },
      },
    );
    const raw = json.output1 ?? json.output ?? [];
    const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return rows
      .map((row) => {
        const side: "buy" | "sell" =
          String(row.sll_buy_dvsn_cd ?? "") === "01" ? "sell" : "buy";
        const qty = asNumber(row.ord_qty);
        const filledQty = asNumber(row.tot_ccld_qty);
        const rawNccs = row.nccs_qty ?? row.NCCS_QTY;
        const unfilledQty =
          rawNccs === undefined || rawNccs === null || String(rawNccs).trim() === ""
            ? Math.max(0, qty - filledQty)
            : asNumber(rawNccs);
        return {
          orderNo: String(row.odno ?? row.ODNO ?? "").trim(),
          ticker: String(row.pdno ?? row.PDNO ?? "").padStart(6, "0"),
          side,
          qty,
          filledQty,
          unfilledQty,
          avgPrice: asNumber(row.avg_prvs) || asNumber(row.avg_ccld_unpr),
        };
      })
      .filter((row) => row.orderNo || row.ticker);
  }

  private assertConfigured() {
    if (!this.config.configured) {
      throw new Error(this.config.issues[0] ?? "한국투자증권 Open API 설정이 없습니다.");
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

  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.access;
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
    this.token = {
      access,
      expiresAt: Date.now() + Math.max(60, expiresIn - 3_600) * 1000,
    };
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
    );
  }

  private async request(
    method: string,
    url: string,
    init: { headers: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return this.slot(async () => {
      const res = await this.fetchImpl(url, {
        method,
        headers: init.headers,
        body: method === "GET" ? undefined : init.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw new Error(`KIS 응답이 JSON이 아닙니다. HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(
          String(json.msg1 ?? json.error_description ?? `KIS HTTP ${res.status}`),
        );
      }
      const rt = json.rt_cd;
      if (rt !== undefined && String(rt) !== "0") {
        if (String(json.msg_cd ?? "").includes("EGW00123")) {
          this.token = null;
        }
        throw new Error(String(json.msg1 ?? json.msg_cd ?? "KIS 오류"));
      }
      return json;
    });
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

let shared: KisClient | null = null;

export function getSharedKisClient(): KisClient {
  shared ??= KisClient.fromEnv();
  return shared;
}

export function resetSharedKisClient() {
  shared = null;
}
