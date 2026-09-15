export type ConditionKind = "interval" | "ma-cross";

export type UserRule = {
  id: string;
  name: string;
  ticker: string;
  kind: ConditionKind;
  /** 실행 주기 (interval 조건식). */
  intervalMs: number;
  fastMa: number;
  slowMa: number;
  /** 1회 매수 금액 = min(sliceKrw, 룰 예수금 * buyPct). */
  buyPct: number;
  sliceKrw: number;
  minAmountKrw: number;
  stopLossPct: number;
  takeProfitPct: number;
  enabled: boolean;
  budget: number;
};

export type RuleConfigFile = {
  rules: UserRule[];
};

export const CASH_RULE_ID = "cash";

export const EMPTY_RULE_CONFIG: RuleConfigFile = { rules: [] };

export const DISCLAIMER_TEXT =
  "본 서비스는 사용자가 설정한 조건에 따라 기계적으로 API 매매를 대행하는 소프트웨어 도구일 뿐이며, 종목 추천이나 투자 일임을 수행하지 않습니다. 모든 투자 판단과 매매 결과에 대한 책임은 사용자 본인에게 있습니다.";

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asPositive(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n > 0 ? n : undefined;
}

export function asUnitInterval(value: unknown): number | undefined {
  const n = asNumber(value);
  return n != null && n >= 0 && n <= 1 ? n : undefined;
}

export function normalizeTicker(value: unknown): string | undefined {
  const digits = String(value ?? "").replace(/\D/g, "").slice(-6).padStart(6, "0");
  if (!/^\d{6}$/.test(digits) || digits === "000000") return undefined;
  return digits;
}

export function isLegacyPlaybookId(id: string | undefined): boolean {
  return id === "Level1_Stable" || id === "Level5_Swing" || id === "Level10_Aggressive";
}

export function blankRule(partial: Partial<UserRule> = {}): UserRule {
  return {
    id: partial.id ?? crypto.randomUUID(),
    name: partial.name ?? "",
    ticker: partial.ticker ?? "",
    kind: partial.kind === "ma-cross" ? "ma-cross" : "interval",
    intervalMs: partial.intervalMs ?? 60_000,
    fastMa: partial.fastMa ?? 5,
    slowMa: partial.slowMa ?? 20,
    buyPct: partial.buyPct ?? 0.1,
    sliceKrw: partial.sliceKrw ?? 100_000,
    minAmountKrw: partial.minAmountKrw ?? 10_000,
    stopLossPct: partial.stopLossPct ?? 0.05,
    takeProfitPct: partial.takeProfitPct ?? 0.03,
    enabled: partial.enabled ?? true,
    budget: partial.budget ?? 0,
  };
}

function parseKind(value: unknown): ConditionKind {
  return value === "ma-cross" ? "ma-cross" : "interval";
}

export function parseUserRule(raw: unknown, fallbackId?: string): UserRule | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const ticker = normalizeTicker(input.ticker);
  if (!ticker) return null;
  const id =
    typeof input.id === "string" && input.id.trim() && !isLegacyPlaybookId(input.id)
      ? input.id.trim()
      : fallbackId ?? crypto.randomUUID();
  const kind = parseKind(input.kind);
  const fastMa = Math.round(asPositive(input.fastMa) ?? 5);
  const slowMa = Math.round(asPositive(input.slowMa) ?? 20);
  return {
    id,
    name: typeof input.name === "string" ? input.name.trim() : "",
    ticker,
    kind,
    intervalMs: Math.round(asPositive(input.intervalMs) ?? 60_000),
    fastMa,
    slowMa,
    buyPct: asUnitInterval(input.buyPct) ?? 0.1,
    sliceKrw: Math.round(asPositive(input.sliceKrw) ?? 100_000),
    minAmountKrw: Math.round(asPositive(input.minAmountKrw) ?? 10_000),
    stopLossPct: asUnitInterval(input.stopLossPct) ?? 0.05,
    takeProfitPct: asUnitInterval(input.takeProfitPct) ?? 0.03,
    enabled: input.enabled !== false,
    budget: Math.max(0, Math.round(asNumber(input.budget) ?? 0)),
  };
}

export function mergeRuleConfig(raw: unknown): RuleConfigFile {
  if (!raw || typeof raw !== "object") return { rules: [] };
  const input = raw as Record<string, unknown>;
  const list = Array.isArray(input.rules) ? input.rules : [];
  const rules: UserRule[] = [];
  for (const row of list) {
    const parsed = parseUserRule(row);
    if (parsed) rules.push(parsed);
  }
  return { rules };
}

export function overlayRuleConfig(base: RuleConfigFile, raw: unknown): RuleConfigFile {
  if (!raw || typeof raw !== "object") return { rules: base.rules.map((row) => ({ ...row })) };
  const input = raw as Record<string, unknown>;
  if (Array.isArray(input.rules)) return mergeRuleConfig(raw);
  const single = parseUserRule(raw);
  if (!single) return { rules: base.rules.map((row) => ({ ...row })) };
  const rules = base.rules.map((row) => ({ ...row }));
  const idx = rules.findIndex((row) => row.id === single.id);
  if (idx >= 0) rules[idx] = { ...rules[idx], ...single };
  else rules.push(single);
  return { rules };
}

export function validateRuleConfig(config: RuleConfigFile): string | null {
  for (const rule of config.rules) {
    if (!normalizeTicker(rule.ticker)) return "종목코드 6자리가 필요합니다.";
    if (rule.kind === "interval" && rule.intervalMs < 1_000) {
      return "실행 주기는 1초 이상이어야 합니다.";
    }
    if (rule.kind === "ma-cross" && rule.fastMa >= rule.slowMa) {
      return "단기 이평은 장기 이평보다 짧아야 합니다.";
    }
    if (rule.buyPct <= 0 || rule.buyPct > 1) return "1회 매수 비중은 0과 1 사이여야 합니다.";
    if (rule.stopLossPct <= 0 || rule.stopLossPct > 1) return "손절 비율이 올바르지 않습니다.";
    if (rule.takeProfitPct < 0 || rule.takeProfitPct > 1) return "익절 비율이 올바르지 않습니다.";
  }
  return null;
}

export function watchedRuleTickers(config: RuleConfigFile): string[] {
  return [...new Set(config.rules.map((row) => row.ticker).filter(Boolean))];
}
