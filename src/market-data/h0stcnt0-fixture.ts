/**
 * Build an official-shaped H0STCNT0 realtime pipe message for tests.
 */
import { H0STCNT0_COLUMNS, H0STCNT0_FIELD_WIDTH, H0STCNT0_TR_ID } from "@/src/market-data/h0stcnt0";

export type H0stCnt0FixtureOverrides = Partial<Record<(typeof H0STCNT0_COLUMNS)[number], string>>;

function rowFields(overrides: H0stCnt0FixtureOverrides = {}): string[] {
  return H0STCNT0_COLUMNS.map((name) => {
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
}

export function buildH0stCnt0Fixture(overrides: H0stCnt0FixtureOverrides = {}): string {
  const fields = rowFields(overrides);
  return `0|${H0STCNT0_TR_ID}|001|${fields.join("^")}`;
}

/** Multi-row frame: data_cnt = rows.length, fields concatenated. */
export function buildH0stCnt0MultiFixture(rows: H0stCnt0FixtureOverrides[]): string {
  const all: string[] = [];
  for (const overrides of rows) {
    all.push(...rowFields(overrides));
  }
  const cnt = String(rows.length).padStart(3, "0");
  return `0|${H0STCNT0_TR_ID}|${cnt}|${all.join("^")}`;
}

/** Truncate the last row so it is incomplete (malformed). */
export function buildH0stCnt0MultiWithMalformedSecond(
  first: H0stCnt0FixtureOverrides,
  secondPartialFields: string[],
): string {
  const fields = [...rowFields(first), ...secondPartialFields];
  return `0|${H0STCNT0_TR_ID}|002|${fields.join("^")}`;
}

export { H0STCNT0_FIELD_WIDTH };
