import type { BrokerDriver, BrokerPublicStatus } from "@/lib/types";
import { realKisOrdersLocked } from "@/src/runtime/trading-mode";

/** KIS REST/WS environment. MOCK is a broker driver, not a KIS host. */
export type KisEnvironment = "paper" | "real";
/** @deprecated Use KisEnvironment. `demo` env alias still maps to paper. */
export type KisMode = KisEnvironment;
export type TradingEnvironment = "mock" | "paper" | "real";

export const KIS_LIVE_CONFIRM_VALUE = "I_UNDERSTAND";

export const KIS_HOSTS: Record<KisEnvironment, string> = {
  paper: "https://openapivts.koreainvestment.com:29443",
  real: "https://openapi.koreainvestment.com:9443",
};

export const KIS_WS: Record<KisEnvironment, string> = {
  paper: "ws://ops.koreainvestment.com:31000",
  real: "ws://ops.koreainvestment.com:21000",
};

export const KIS_TR = {
  buy: { paper: "VTTC0012U", real: "TTTC0012U" },
  sell: { paper: "VTTC0011U", real: "TTTC0011U" },
  price: "FHKST01010100",
  daily: "FHKST03010100",
  /** 주식일별주문체결조회 3개월 이내. Open Orders/Executions 공통. */
  dailyCcld: { paper: "VTTC0081R", real: "TTTC0081R" },
  /** Alias of dailyCcld. Domestic open orders are CCLD_DVSN=02, not inquire-nccs. */
  openOrders: { paper: "VTTC0081R", real: "TTTC0081R" },
  cancel: { paper: "VTTC0013U", real: "TTTC0013U" },
  balance: { paper: "VTTC8434R", real: "TTTC8434R" },
} as const;

/** Official EXCG_ID_DVSN_CD values. Default KRX; NXT/SOR remain valid later. */
export const KIS_EXCHANGE = {
  krx: "KRX",
  nxt: "NXT",
  sor: "SOR",
  all: "ALL",
} as const;
export type KisExchangeId = (typeof KIS_EXCHANGE)[keyof typeof KIS_EXCHANGE];

/**
 * Official overseas TR IDs from koreainvestment/open-trading-api examples_llm (2025).
 * Quote EXCD (NAS/NYS/AMS) is not the trading OVRS_EXCG_CD (NASD/NYSE/AMEX).
 * US PAPER sell is VTTT1001U — official comment exception, not a blind V-prefix of TTTT1006U.
 */
export const KIS_OVERSEAS_TR = {
  price: "HHDFS00000300",
  searchInfo: "CTPF1702R",
  inquireSearch: "HHDFS76410000",
  countriesHoliday: "CTOS5011R",
  balance: { paper: "VTTS3012R", real: "TTTS3012R" },
  psamount: { paper: "VTTS3007R", real: "TTTS3007R" },
  presentBalance: { paper: "VTRP6504R", real: "CTRP6504R" },
  /** Official inquire_nccs.py hardcodes TTTS3018R and omits the demo branch. VTS rejects it as not a mock TR. Paper uses the official demo prefix rule `V` + rest → VTTS3018R. */
  nccs: { paper: "VTTS3018R", real: "TTTS3018R" },
  ccnl: { paper: "VTTS3035R", real: "TTTS3035R" },
  usBuy: { paper: "VTTT1002U", real: "TTTT1002U" },
  usSell: { paper: "VTTT1001U", real: "TTTT1006U" },
  cancel: { paper: "VTTT1004U", real: "TTTT1004U" },
  /** REAL-only inquiry. Official sample has no demo TR. Not an FX execution API. */
  foreignMargin: "TTTC2101R",
} as const;

const PAPER_KEYS = {
  appKey: "KIS_PAPER_APP_KEY",
  appSecret: "KIS_PAPER_APP_SECRET",
  accountNo: "KIS_PAPER_ACCOUNT_NO",
} as const;

const REAL_KEYS = {
  appKey: "KIS_REAL_APP_KEY",
  appSecret: "KIS_REAL_APP_SECRET",
  accountNo: "KIS_REAL_ACCOUNT_NO",
} as const;

const LEGACY_KEYS = ["KIS_APP_KEY", "KIS_APP_SECRET", "KIS_ACCOUNT_NO"] as const;

export type KisConfig = {
  environment: KisEnvironment;
  /** Same as environment. Kept for KisApi / UI. */
  mode: KisMode;
  appKey: string;
  appSecret: string;
  accountNo: string;
  cano: string;
  productCode: string;
  liveEnabled: boolean;
  configured: boolean;
  issues: string[];
  host: string;
  websocketUrl: string;
  tokenCacheKey: "kis:token:paper" | "kis:token:real";
  credentialSet: KisEnvironment;
};

export type EnvMap = Record<string, string | undefined>;

export class KisCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KisCredentialError";
  }
}

export function brokerDriver(env: EnvMap = process.env): BrokerDriver {
  return env.BROKER === "kis" ? "kis" : "mock";
}

/** MOCK when BROKER!=kis. PAPER/REAL from KIS_MODE (demo|paper → paper, real → real). */
export function resolveTradingEnvironment(env: EnvMap = process.env): TradingEnvironment {
  if (brokerDriver(env) !== "kis") return "mock";
  return resolveKisEnvironment(env);
}

export function resolveKisEnvironment(env: EnvMap = process.env): KisEnvironment {
  const raw = String(env.KIS_MODE ?? env.KIS_ENV ?? "paper")
    .trim()
    .toLowerCase();
  if (raw === "real") return "real";
  if (raw === "paper" || raw === "demo" || raw === "") return "paper";
  throw new KisCredentialError(
    `알 수 없는 KIS_MODE=${raw}. paper(또는 demo) 또는 real 만 허용합니다.`,
  );
}

/** Accepts `12345678-01`, `1234567801`, or 8-digit CANO (product defaults to 01). */
export function parseAccountNo(
  raw: string | undefined,
): { cano: string; productCode: string } | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return { cano: digits.slice(0, 8), productCode: digits.slice(8) };
  }
  if (digits.length === 8) {
    return { cano: digits, productCode: "01" };
  }
  return null;
}

/** 12345678-01 → ******78-01. Never log the full account. */
export function maskAccountNo(cano: string, productCode: string): string {
  if (!cano) return "****";
  const visible = cano.slice(-2);
  return `${"*".repeat(Math.max(0, cano.length - visible.length))}${visible}-${productCode}`;
}

function readSet(
  env: EnvMap,
  keys: typeof PAPER_KEYS | typeof REAL_KEYS,
): { appKey: string; appSecret: string; accountNo: string } {
  return {
    appKey: env[keys.appKey]?.trim() ?? "",
    appSecret: env[keys.appSecret]?.trim() ?? "",
    accountNo: env[keys.accountNo]?.trim() ?? "",
  };
}

function missingCredentialMessages(
  environment: KisEnvironment,
  creds: { appKey: string; appSecret: string; accountNo: string },
  parsed: ReturnType<typeof parseAccountNo>,
): string[] {
  const keys = environment === "real" ? REAL_KEYS : PAPER_KEYS;
  const label = environment === "real" ? "REAL" : "PAPER";
  const issues: string[] = [];
  if (!creds.appKey) issues.push(`${label}인데 ${keys.appKey}가 없습니다.`);
  if (!creds.appSecret) issues.push(`${label}인데 ${keys.appSecret}가 없습니다.`);
  if (!creds.accountNo) {
    issues.push(`${label}인데 ${keys.accountNo}가 없습니다.`);
  } else if (!parsed) {
    issues.push(`${keys.accountNo}는 8자리 계좌+2자리 상품코드여야 합니다. 예: 12345678-01`);
  }
  return issues;
}

function buildConfig(
  environment: KisEnvironment,
  creds: { appKey: string; appSecret: string; accountNo: string },
  env: EnvMap,
): KisConfig {
  const parsed = parseAccountNo(creds.accountNo);
  const issues = missingCredentialMessages(environment, creds, parsed);
  if (LEGACY_KEYS.some((key) => env[key]?.trim())) {
    issues.push(
      "KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 는 더 이상 쓰지 않습니다. KIS_PAPER_* 또는 KIS_REAL_* 만 사용합니다.",
    );
  }

  const confirmed = env.KIS_LIVE_CONFIRM === KIS_LIVE_CONFIRM_VALUE;
  const realUnlocked = environment === "real" && confirmed && !realKisOrdersLocked(env);
  const configured = Boolean(creds.appKey && creds.appSecret && parsed);
  const liveEnabled = environment === "paper" ? configured : configured && realUnlocked;

  if (environment === "real" && configured && !confirmed) {
    issues.push(
      `실전 주문은 KIS_LIVE_CONFIRM=${KIS_LIVE_CONFIRM_VALUE} 가 필요합니다. 시세 조회만 가능합니다.`,
    );
  } else if (environment === "real" && configured && !realUnlocked) {
    issues.push(realKisOrdersLocked(env) ?? "실전 KIS 주문이 잠겨 있습니다.");
  }

  const cano = parsed?.cano ?? "";
  const productCode = parsed?.productCode ?? "01";

  return {
    environment,
    mode: environment,
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accountNo: creds.accountNo,
    cano,
    productCode,
    liveEnabled,
    configured,
    issues,
    host: KIS_HOSTS[environment],
    websocketUrl: KIS_WS[environment],
    tokenCacheKey: environment === "real" ? "kis:token:real" : "kis:token:paper",
    credentialSet: environment,
  };
}

/**
 * Fail-fast config for the given environment.
 * PAPER reads only KIS_PAPER_*. REAL reads only KIS_REAL_*. No cross-fallback.
 */
export function getKisConfig(
  environment: TradingEnvironment,
  env: EnvMap = process.env,
): KisConfig {
  if (environment === "mock") {
    throw new KisCredentialError("MockBroker는 KIS credential이 필요하지 않습니다.");
  }
  const keys = environment === "real" ? REAL_KEYS : PAPER_KEYS;
  const creds = readSet(env, keys);
  const cfg = buildConfig(environment, creds, env);
  const blocking = cfg.issues.filter(
    (msg) => msg.includes("가 없습니다") || msg.includes("여야 합니다"),
  );
  if (blocking.length) {
    throw new KisCredentialError(blocking[0]!);
  }
  return cfg;
}

/** Dashboard / client inspect. Does not throw. Never copies the other environment's secrets. */
export function loadKisConfig(env: EnvMap = process.env): KisConfig {
  let environment: KisEnvironment;
  try {
    environment = resolveKisEnvironment(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "KIS_MODE 가 올바르지 않습니다.";
    const cfg = buildConfig("paper", { appKey: "", appSecret: "", accountNo: "" }, env);
    return { ...cfg, issues: [message, ...cfg.issues] };
  }
  const keys = environment === "real" ? REAL_KEYS : PAPER_KEYS;
  return buildConfig(environment, readSet(env, keys), env);
}

export function getBrokerPublicStatus(
  env: EnvMap = process.env,
): BrokerPublicStatus {
  const driver = brokerDriver(env);
  if (driver === "mock") {
    return {
      driver: "mock",
      mode: null,
      configured: true,
      liveEnabled: false,
      accountMasked: null,
      message: "로컬 페이퍼 북으로 체결합니다. 실제 주문은 나가지 않습니다.",
    };
  }

  const kis = loadKisConfig(env);
  if (!kis.configured) {
    return {
      driver: "kis",
      mode: kis.mode,
      configured: false,
      liveEnabled: false,
      accountMasked: null,
      message: kis.issues[0] ?? "한국투자증권 앱키가 설정되지 않았습니다.",
    };
  }

  const accountMasked = maskAccountNo(kis.cano, kis.productCode);
  if (kis.mode === "real" && !kis.liveEnabled) {
    return {
      driver: "kis",
      mode: "real",
      configured: true,
      liveEnabled: false,
      accountMasked,
      message: `시세는 실전 Open API를 쓰고, 주문은 KIS_LIVE_CONFIRM=${KIS_LIVE_CONFIRM_VALUE} 가 있을 때만 나갑니다.`,
    };
  }

  return {
    driver: "kis",
    mode: kis.mode,
    configured: true,
    liveEnabled: kis.liveEnabled,
    accountMasked,
    message:
      kis.mode === "real"
        ? `한국투자증권 실전 계좌 ${accountMasked} 로 주문을 냅니다.`
        : `한국투자증권 모의투자(VTS) 계좌 ${accountMasked} 로 주문을 냅니다.`,
  };
}
