import type { BrokerDriver, BrokerPublicStatus } from "@/lib/types";

export type KisMode = "demo" | "real";

export const KIS_LIVE_CONFIRM_VALUE = "I_UNDERSTAND";

export const KIS_HOSTS: Record<KisMode, string> = {
  demo: "https://openapivts.koreainvestment.com:29443",
  real: "https://openapi.koreainvestment.com:9443",
};

export const KIS_TR = {
  buy: { demo: "VTTC0802U", real: "TTTC0802U" },
  sell: { demo: "VTTC0801U", real: "TTTC0801U" },
  price: "FHKST01010100",
  daily: "FHKST03010100",
  dailyCcld: { demo: "VTTC8001R", real: "TTTC8001R" },
  cancel: { demo: "VTTC0803U", real: "TTTC0803U" },
  balance: { demo: "VTTC8434R", real: "TTTC8434R" },
} as const;

export type KisConfig = {
  appKey: string;
  appSecret: string;
  accountNo: string;
  cano: string;
  productCode: string;
  mode: KisMode;
  liveEnabled: boolean;
  configured: boolean;
  issues: string[];
  host: string;
};

export type EnvMap = Record<string, string | undefined>;

export function brokerDriver(env: EnvMap = process.env): BrokerDriver {
  return env.BROKER === "kis" ? "kis" : "mock";
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

export function maskAccountNo(cano: string, productCode: string): string {
  if (cano.length < 4) return "****";
  return `${cano.slice(0, 4)}****-${productCode}`;
}

export function loadKisConfig(env: EnvMap = process.env): KisConfig {
  const appKey = env.KIS_APP_KEY?.trim() ?? "";
  const appSecret = env.KIS_APP_SECRET?.trim() ?? "";
  const accountNo = env.KIS_ACCOUNT_NO?.trim() ?? "";
  const mode: KisMode = env.KIS_MODE === "real" ? "real" : "demo";
  const parsed = parseAccountNo(accountNo);
  const issues: string[] = [];

  if (!appKey) issues.push("KIS_APP_KEY 가 없습니다.");
  if (!appSecret) issues.push("KIS_APP_SECRET 가 없습니다.");
  if (!parsed) {
    issues.push("KIS_ACCOUNT_NO 는 8자리 계좌+2자리 상품코드여야 합니다. 예: 12345678-01");
  }

  const liveEnabled =
    mode === "demo" || env.KIS_LIVE_CONFIRM === KIS_LIVE_CONFIRM_VALUE;
  if (mode === "real" && !liveEnabled) {
    issues.push(
      `실전 주문은 KIS_LIVE_CONFIRM=${KIS_LIVE_CONFIRM_VALUE} 가 필요합니다. 시세 조회만 가능합니다.`,
    );
  }

  const cano = parsed?.cano ?? "";
  const productCode = parsed?.productCode ?? "01";

  return {
    appKey,
    appSecret,
    accountNo,
    cano,
    productCode,
    mode,
    liveEnabled,
    configured: Boolean(appKey && appSecret && parsed),
    issues,
    host: KIS_HOSTS[mode],
  };
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

  if (kis.mode === "real" && !kis.liveEnabled) {
    return {
      driver: "kis",
      mode: "real",
      configured: true,
      liveEnabled: false,
      accountMasked: maskAccountNo(kis.cano, kis.productCode),
      message: `시세는 실전 Open API를 쓰고, 주문은 KIS_LIVE_CONFIRM=${KIS_LIVE_CONFIRM_VALUE} 가 있을 때만 나갑니다.`,
    };
  }

  return {
    driver: "kis",
    mode: kis.mode,
    configured: true,
    liveEnabled: kis.liveEnabled,
    accountMasked: maskAccountNo(kis.cano, kis.productCode),
    message:
      kis.mode === "real"
        ? `한국투자증권 실전 계좌 ${maskAccountNo(kis.cano, kis.productCode)} 로 주문을 냅니다.`
        : `한국투자증권 모의투자(VTS) 계좌 ${maskAccountNo(kis.cano, kis.productCode)} 로 주문을 냅니다.`,
  };
}
