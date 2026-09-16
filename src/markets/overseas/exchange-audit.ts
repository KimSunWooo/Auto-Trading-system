import type { CurrencyExchangeAudit } from "@/src/markets/overseas/types";

/**
 * Official KIS Open API audit (koreainvestment/open-trading-api examples_llm, 2025 samples).
 *
 * A. Inquiry APIs that exist:
 *    - 해외주식 잔고 inquire-balance VTTS3012R/TTTS3012R
 *    - 매수가능금액 inquire-psamount VTTS3007R/TTTS3007R
 *    - 체결기준현재잔고 inquire-present-balance VTRP6504R/CTRP6504R (includes FX / 외화예수금)
 *    - 해외증거금 통화별조회 foreign-margin TTTC2101R (REAL inquiry only, no demo TR in official sample)
 *
 * B. Execution API for KRW↔USD 환전:
 *    Official examples_llm/overseas_stock has no 환전/currency-exchange order endpoint.
 *    foreign_margin is GET inquiry (TTTC2101R), not an exchange order.
 *    Do not invent a fake exchange API.
 */
export const KIS_CURRENCY_EXCHANGE_AUDIT: CurrencyExchangeAudit = {
  supported: "NO",
  paperVtsExecutionSupported: "NO",
  implementation:
    "환전 실행 API는 공식 샘플에 없다. 환율·외화예수금·매수가능금액 조회만 구현한다. 해외 주문은 KIS PAPER 외화자금/매수가능금액을 기준으로 한다. echm_af_ord_psbl_amt 는 환전이후주문가능금액 조회 필드이며 환전 실행이 아니다.",
  inquiryApis: [
    "GET /uapi/overseas-stock/v1/trading/inquire-present-balance VTRP6504R/CTRP6504R",
    "GET /uapi/overseas-stock/v1/trading/inquire-balance VTTS3012R/TTTS3012R",
    "GET /uapi/overseas-stock/v1/trading/inquire-psamount VTTS3007R/TTTS3007R",
    "GET /uapi/overseas-stock/v1/trading/foreign-margin TTTC2101R (REAL inquiry only)",
  ],
};

/**
 * Official KIS sources checked for PAPER overseas-stock USD funding.
 * Do not invent a local FX/funding API from this audit.
 */
export const KIS_PAPER_OVERSEAS_FUNDING_AUDIT = {
  paperUsdFundingMethod: "NOT VERIFIED" as const,
  paperFxExecutionApi: "UNSUPPORTED" as const,
  paperKrwBasedOverseasOrder: "NOT VERIFIED" as const,
  notes: [
    "koreainvestment/open-trading-api examples_llm/overseas_stock has no KRW→USD 환전 execution endpoint.",
    "foreign_margin is GET inquiry TTTC2101R with no demo TR in the official sample.",
    "inquire-psamount echm_af_ord_psbl_amt is 환전이후주문가능금액 inquiry, not FX execution.",
    "Official US order sample uses OVRS_ORD_UNPR in native currency; no KRW order field.",
    "securities.koreainvestment.com virtual-trading page documents USD 100,000 for 해외선물옵션 only, not overseas stocks.",
    "REAL HTS [H702]/[7473] 환전·해외증권 신청 is live-account guidance, not a PAPER Open API method.",
    "Whether eFriend/MTS mock screens can seed overseas-stock USD cash is not stated in the Open API repo.",
  ],
};
