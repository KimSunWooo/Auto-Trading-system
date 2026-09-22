import type { ConditionKind } from "@/src/rules/params";

export type AdminPlaybookId = "Level1_Stable" | "Level5_Swing" | "Level10_Aggressive";

export type AdminPresetDraft = {
  ticker: string;
  name: string;
  kind: ConditionKind;
  intervalSec: string;
  fastMa: string;
  slowMa: string;
  buyPct: string;
  sliceKrw: string;
  stopLossPct: string;
  takeProfitPct: string;
  budget: string;
  enabled: boolean;
};

export type AdminPreset = {
  id: AdminPlaybookId;
  label: string;
  summary: string;
  /** Extra tickers for Level10. Form fills one ticker at a time. */
  universe?: string[];
  k?: number;
  minDayReturn?: number;
  draft: AdminPresetDraft;
};

/**
 * Operator-only copies of the retired playbooks. Not loaded by QuantEngine.
 * Public B2C still starts from `{ rules: [] }`.
 */
export const ADMIN_PRESETS: readonly AdminPreset[] = [
  {
    id: "Level1_Stable",
    label: "안정형",
    summary: "KODEX 200 적립식",
    draft: {
      ticker: "069500",
      name: "안정형 · KODEX 200 적립",
      kind: "interval",
      intervalSec: "45",
      fastMa: "5",
      slowMa: "20",
      buyPct: "5",
      sliceKrw: "150000",
      stopLossPct: "5",
      takeProfitPct: "3",
      budget: "7000000",
      enabled: true,
    },
  },
  {
    id: "Level5_Swing",
    label: "중립형",
    summary: "삼성전자 5/20 이평",
    draft: {
      ticker: "005930",
      name: "중립형 · 삼성전자 이평 스윙",
      kind: "ma-cross",
      intervalSec: "60",
      fastMa: "5",
      slowMa: "20",
      buyPct: "35",
      sliceKrw: "1750000",
      stopLossPct: "5",
      takeProfitPct: "3",
      budget: "2000000",
      enabled: true,
    },
  },
  {
    id: "Level10_Aggressive",
    label: "공격형",
    summary: "6종목 변동성 돌파",
    universe: ["005930", "000660", "035720", "247540", "259960", "352820"],
    k: 0.4,
    minDayReturn: 0.004,
    draft: {
      ticker: "005930",
      name: "공격형 · 변동성 돌파",
      kind: "interval",
      intervalSec: "120",
      fastMa: "5",
      slowMa: "20",
      buyPct: "25",
      sliceKrw: "750000",
      stopLossPct: "5",
      takeProfitPct: "3",
      budget: "1000000",
      enabled: true,
    },
  },
] as const;

export const AGGRESSIVE_UNIVERSE = ADMIN_PRESETS[2]?.universe ?? [];

/**
 * @deprecated Never use for authorization. ADMIN UI must gate on users.role === ADMIN
 * via /api/admin/presets. Always returns false.
 */
export function isAdminModeEnv(_value = process.env.NEXT_PUBLIC_ADMIN_MODE): boolean {
  return false;
}

/**
 * @deprecated Never use for authorization. localhost is not ADMIN.
 */
export function isLocalAdminHost(_hostname: string | undefined): boolean {
  return false;
}

/**
 * @deprecated Never use for authorization. Always false — role is server-enforced.
 */
export function isAdminPresetUiEnabled(
  _hostname?: string,
  _envValue = process.env.NEXT_PUBLIC_ADMIN_MODE,
): boolean {
  return false;
}

export function adminPresetById(id: AdminPlaybookId): AdminPreset {
  const found = ADMIN_PRESETS.find((row) => row.id === id);
  if (!found) throw new Error(`unknown admin preset ${id}`);
  return found;
}

function nextUniverseTicker(universe: string[], current?: string): string {
  if (universe.length === 0) return current ?? "";
  const idx = current ? universe.indexOf(current) : -1;
  if (idx < 0) return universe[0]!;
  return universe[(idx + 1) % universe.length]!;
}

/** Overwrite DIY form state with a retired playbook. Level10 cycles the 6-name universe. */
export function applyAdminPreset(
  id: AdminPlaybookId,
  current?: Pick<AdminPresetDraft, "ticker">,
): AdminPresetDraft {
  const preset = adminPresetById(id);
  const ticker = preset.universe
    ? nextUniverseTicker(preset.universe, current?.ticker)
    : preset.draft.ticker;
  const name =
    preset.id === "Level10_Aggressive"
      ? `공격형 · 변동성 돌파 ${ticker}`
      : preset.draft.name;
  return {
    ...preset.draft,
    ticker,
    name,
  };
}
