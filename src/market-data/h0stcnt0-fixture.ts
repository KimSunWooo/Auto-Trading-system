/**
 * Build an official-shaped H0STCNT0 realtime pipe message for tests.
 */
import { H0STCNT0_COLUMNS, H0STCNT0_TR_ID } from "@/src/market-data/h0stcnt0";

export type H0stCnt0FixtureOverrides = Partial<Record<(typeof H0STCNT0_COLUMNS)[number], string>>;

export function buildH0stCnt0Fixture(overrides: H0stCnt0FixtureOverrides = {}): string {
  const fields = H0STCNT0_COLUMNS.map((name) => {
    if (overrides[name] != null) return overrides[name]!;
    switch (name) {
      case "MKSC_SHRN_ISCD":
        return "035720";
      case "STCK_CNTG_HOUR":
        return "103015";
      case "STCK_PRPR":
        return "45200";
      case "STCK_OPRC":
        return "44800";
      case "STCK_HGPR":
        return "45500";
      case "STCK_LWPR":
        return "44700";
      case "ASKP1":
        return "45250";
      case "BIDP1":
        return "45150";
      case "CNTG_VOL":
        return "12";
      case "ACML_VOL":
        return "1234567";
      case "BSOP_DATE":
        return "20260322";
      default:
        return "0";
    }
  });
  return `0|${H0STCNT0_TR_ID}|001|${fields.join("^")}`;
}
