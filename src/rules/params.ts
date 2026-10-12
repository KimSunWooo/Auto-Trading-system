export type ConditionKind = "interval" | "ma-cross";

/** How strategy cash ceiling is derived. Never reinterpret buyPct as allocationPct. */
export type BudgetMode = "legacy_fixed" | "orderable_ratio";

export type UserRule = {
  id: string;
  name: string;
  ticker: string;
  /** Optional instrument master id (UUID). Additive — legacy rules omit it. */
  instrumentId?: string;
  /** Optional canonical key e.g. KR:KOSPI:005930. Additive. */
  instrumentKey?: string;
  kind: ConditionKind;
  /**
   * Condition evaluation cadence (ms).
   * For interval rules this is NOT the buy permission cadence —
   * see minBuyIntervalMs / maxExecutionsPerDay.
   */
  intervalMs: number;
  fastMa: number;
  slowMa: number;
  /**
   * 1회 매수 비율 — fraction of this strategy's current buyable cash for one signal.
   * NOT the account allocation ratio (see allocationPct).
   */
  buyPct: number;
  /** Optional KRW cap applied after buyPct. */
  sliceKrw: number;
  minAmountKrw: number;
  stopLossPct: number;
  takeProfitPct: number;
  enabled: boolean;
  /**
   * Legacy fixed KRW budget. Kept for compatibility; ignored as source of truth
   * when budgetMode === "orderable_ratio".
   */
  budget: number;
  /**
   * orderable_ratio (default for new rules) | legacy_fixed (existing without allocationPct).
   */
  budgetMode?: BudgetMode;
  /**
   * Strategy allocation ratio of distributable PAPER orderable cash (0–1).
   * Distinct from buyPct.
   */
  allocationPct?: number;
  /**
   * Safe execution budgets. When omitted, resolveExecutionBudget applies
   * conservative defaults (never unlimited).
   */
  maxExecutionsPerDay?: number;
  maxDailyBuyKrw?: number;
  maxPositionQty?: number;
  maxPositionKrw?: number;
  /** 0–1 fraction of totalDeposit. */
  maxTotalExposurePct?: number;
  /** Min gap between BUY attempts; evaluation may still run every intervalMs. */
  minBuyIntervalMs?: number;
};

export type RuleConfigFile = {
  rules: UserRule[];
  /** Monotonic config version for optimistic concurrency. */
  version?: number;
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

function optionalPositiveInt(value: unknown): number | undefined {
  const n = asPositive(value);
  return n != null ? Math.floor(n) : undefined;
}

function optionalUnit(value: unknown): number | undefined {
  return asUnitInterval(value);
}

export function blankRule(partial: Partial<UserRule> = {}): UserRule {
  const hasLegacyBudget =
    partial.budget != null &&
    partial.budget > 0 &&
    partial.allocationPct == null &&
    partial.budgetMode !== "orderable_ratio";
  const budgetMode: BudgetMode =
    partial.budgetMode ??
    (hasLegacyBudget ? "legacy_fixed" : "orderable_ratio");
  const rule: UserRule = {
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
    budgetMode,
  };
  if (partial.allocationPct != null) rule.allocationPct = partial.allocationPct;
  else if (budgetMode === "orderable_ratio" && partial.allocationPct === undefined && !hasLegacyBudget) {
    rule.allocationPct = 0;
  }
  if (partial.instrumentId) rule.instrumentId = partial.instrumentId;
  if (partial.instrumentKey) rule.instrumentKey = partial.instrumentKey;
  // Explicit partials only — omit → resolveExecutionBudget supplies conservative defaults.
  if (partial.maxExecutionsPerDay != null) rule.maxExecutionsPerDay = partial.maxExecutionsPerDay;
  if (partial.maxDailyBuyKrw != null) rule.maxDailyBuyKrw = partial.maxDailyBuyKrw;
  if (partial.maxPositionQty != null) rule.maxPositionQty = partial.maxPositionQty;
  if (partial.maxPositionKrw != null) rule.maxPositionKrw = partial.maxPositionKrw;
  if (partial.maxTotalExposurePct != null) rule.maxTotalExposurePct = partial.maxTotalExposurePct;
  if (partial.minBuyIntervalMs != null) rule.minBuyIntervalMs = partial.minBuyIntervalMs;
  return rule;
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
  const instrumentId =
    typeof input.instrumentId === "string" && input.instrumentId.trim()
      ? input.instrumentId.trim()
      : undefined;
  const instrumentKey =
    typeof input.instrumentKey === "string" && input.instrumentKey.trim()
      ? input.instrumentKey.trim()
      : undefined;
  const maxExecutionsPerDay = optionalPositiveInt(input.maxExecutionsPerDay);
  const maxDailyBuyKrw = optionalPositiveInt(input.maxDailyBuyKrw);
  const maxPositionQty = optionalPositiveInt(input.maxPositionQty);
  const maxPositionKrw = optionalPositiveInt(input.maxPositionKrw);
  const maxTotalExposurePct = optionalUnit(input.maxTotalExposurePct);
  const minBuyIntervalMs = optionalPositiveInt(input.minBuyIntervalMs);

  const buyPctRaw = asNumber(input.buyPct);
  if (buyPctRaw != null && !(buyPctRaw >= 0 && buyPctRaw <= 1)) {
    return null;
  }
  const allocationPctRaw = asNumber(input.allocationPct);
  if (allocationPctRaw != null && !(allocationPctRaw >= 0 && allocationPctRaw <= 1)) {
    return null;
  }
  const budgetRaw = asNumber(input.budget);
  if (budgetRaw != null && (!Number.isFinite(budgetRaw) || budgetRaw < 0)) {
    return null;
  }

  const explicitMode =
    input.budgetMode === "legacy_fixed" || input.budgetMode === "orderable_ratio"
      ? (input.budgetMode as BudgetMode)
      : undefined;
  const hasAllocationPct = allocationPctRaw != null;
  const budgetMode: BudgetMode =
    explicitMode ??
    (hasAllocationPct
      ? "orderable_ratio"
      : budgetRaw != null && budgetRaw > 0
        ? "legacy_fixed"
        : "orderable_ratio");

  return {
    id,
    name: typeof input.name === "string" ? input.name.trim() : "",
    ticker,
    ...(instrumentId ? { instrumentId } : {}),
    ...(instrumentKey ? { instrumentKey } : {}),
    kind,
    intervalMs: Math.round(asPositive(input.intervalMs) ?? 60_000),
    fastMa,
    slowMa,
    buyPct: buyPctRaw != null ? buyPctRaw : 0.1,
    sliceKrw: Math.round(asPositive(input.sliceKrw) ?? 100_000),
    minAmountKrw: Math.round(asPositive(input.minAmountKrw) ?? 10_000),
    stopLossPct: asUnitInterval(input.stopLossPct) ?? 0.05,
    takeProfitPct: asUnitInterval(input.takeProfitPct) ?? 0.03,
    enabled: input.enabled !== false,
    budget: Math.max(0, Math.round(budgetRaw ?? 0)),
    budgetMode,
    ...(hasAllocationPct ? { allocationPct: allocationPctRaw } : budgetMode === "orderable_ratio" ? { allocationPct: 0 } : {}),
    ...(maxExecutionsPerDay != null ? { maxExecutionsPerDay } : {}),
    ...(maxDailyBuyKrw != null ? { maxDailyBuyKrw } : {}),
    ...(maxPositionQty != null ? { maxPositionQty } : {}),
    ...(maxPositionKrw != null ? { maxPositionKrw } : {}),
    ...(maxTotalExposurePct != null && maxTotalExposurePct > 0 ? { maxTotalExposurePct } : {}),
    ...(minBuyIntervalMs != null ? { minBuyIntervalMs } : {}),
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
  const version = asNumber(input.version);
  return {
    rules,
    ...(version != null && Number.isInteger(version) && version >= 0 ? { version } : {}),
  };
}

export function overlayRuleConfig(base: RuleConfigFile, raw: unknown): RuleConfigFile {
  if (!raw || typeof raw !== "object") {
    return {
      rules: base.rules.map((row) => ({ ...row })),
      ...(base.version != null ? { version: base.version } : {}),
    };
  }
  const input = raw as Record<string, unknown>;
  if (Array.isArray(input.rules)) {
    const merged = mergeRuleConfig(raw);
    return {
      ...merged,
      version: merged.version ?? base.version,
    };
  }
  // Partial single-rule patch: merge onto existing rule so omitted fields are not defaulted away.
  if (typeof input.id === "string" && input.id.trim()) {
    const rules = base.rules.map((row) => ({ ...row }));
    const idx = rules.findIndex((row) => row.id === input.id);
    if (idx < 0) {
      const single = parseUserRule(raw);
      if (!single) {
        return {
          rules: base.rules.map((row) => ({ ...row })),
          ...(base.version != null ? { version: base.version } : {}),
        };
      }
      rules.push(single);
      return { rules, ...(base.version != null ? { version: base.version } : {}) };
    }
    const prev = rules[idx]!;
    const patched = parseUserRule({ ...prev, ...input }, prev.id);
    if (!patched) throw new Error("잘못된 전략 설정 값입니다.");
    // Preserve fields that parseUserRule may have defaulted when omitted from partial.
    rules[idx] = {
      ...prev,
      ...patched,
      buyPct: input.buyPct !== undefined ? patched.buyPct : prev.buyPct,
      sliceKrw: input.sliceKrw !== undefined ? patched.sliceKrw : prev.sliceKrw,
      minAmountKrw: input.minAmountKrw !== undefined ? patched.minAmountKrw : prev.minAmountKrw,
      stopLossPct: input.stopLossPct !== undefined ? patched.stopLossPct : prev.stopLossPct,
      takeProfitPct: input.takeProfitPct !== undefined ? patched.takeProfitPct : prev.takeProfitPct,
      budget: input.budget !== undefined ? patched.budget : prev.budget,
      budgetMode: input.budgetMode !== undefined || input.allocationPct !== undefined
        ? patched.budgetMode
        : prev.budgetMode,
      allocationPct:
        input.allocationPct !== undefined ? patched.allocationPct : prev.allocationPct,
      enabled: input.enabled !== undefined ? patched.enabled : prev.enabled,
    };
    return { rules, ...(base.version != null ? { version: base.version } : {}) };
  }
  const single = parseUserRule(raw);
  if (!single) {
    return {
      rules: base.rules.map((row) => ({ ...row })),
      ...(base.version != null ? { version: base.version } : {}),
    };
  }
  const rules = base.rules.map((row) => ({ ...row }));
  const idx = rules.findIndex((row) => row.id === single.id);
  if (idx >= 0) rules[idx] = { ...rules[idx], ...single };
  else rules.push(single);
  return { rules, ...(base.version != null ? { version: base.version } : {}) };
}

export function validateRuleConfig(config: RuleConfigFile): string | null {
  for (const rule of config.rules) {
    if (!normalizeTicker(rule.ticker)) return "종목코드 6자리가 필요합니다.";
    if (rule.kind === "interval" && rule.intervalMs < 1_000) {
      return "조건 평가 주기는 1초 이상이어야 합니다.";
    }
    if (rule.kind === "ma-cross" && rule.fastMa >= rule.slowMa) {
      return "단기 이평은 장기 이평보다 짧아야 합니다.";
    }
    if (!(rule.buyPct > 0) || rule.buyPct > 1) return "1회 매수 비중은 0과 1 사이여야 합니다.";
    if (rule.stopLossPct <= 0 || rule.stopLossPct > 1) return "손절 비율이 올바르지 않습니다.";
    if (rule.takeProfitPct < 0 || rule.takeProfitPct > 1) return "익절 비율이 올바르지 않습니다.";
    if (rule.budgetMode === "orderable_ratio" || rule.allocationPct != null) {
      const pct = rule.allocationPct ?? 0;
      if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
        return "전략 배정 비율은 0과 1 사이여야 합니다.";
      }
    }
    if (rule.budget < 0 || !Number.isFinite(rule.budget)) {
      return "레거시 예산이 올바르지 않습니다.";
    }
    if (rule.maxExecutionsPerDay != null && rule.maxExecutionsPerDay < 1) {
      return "일일 실행 한도는 1 이상이어야 합니다.";
    }
    if (rule.maxDailyBuyKrw != null && rule.maxDailyBuyKrw < rule.minAmountKrw) {
      return "일일 매수 한도가 최소 매수 금액보다 작습니다.";
    }
    if (rule.maxPositionQty != null && rule.maxPositionQty < 1) {
      return "포지션 수량 한도는 1 이상이어야 합니다.";
    }
    if (
      rule.maxTotalExposurePct != null &&
      (rule.maxTotalExposurePct <= 0 || rule.maxTotalExposurePct > 1)
    ) {
      return "노출 한도는 0과 1 사이여야 합니다.";
    }
  }
  let activePctSum = 0;
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const mode =
      rule.budgetMode ??
      (rule.allocationPct != null ? "orderable_ratio" : "legacy_fixed");
    if (mode === "orderable_ratio") {
      activePctSum += Math.max(0, rule.allocationPct ?? 0);
    }
  }
  if (activePctSum > 1 + 1e-9) {
    return `활성 전략 배정 비율 합계 ${(activePctSum * 100).toFixed(2)}%가 100%를 초과합니다.`;
  }
  return null;
}

export function watchedRuleTickers(config: RuleConfigFile): string[] {
  return [...new Set(config.rules.map((row) => row.ticker).filter(Boolean))];
}

/** Enabled rules only — display/disabled rules do not drive quote pressure alone. */
export function enabledRuleTickers(config: RuleConfigFile): string[] {
  return [
    ...new Set(
      config.rules.filter((row) => row.enabled && row.ticker).map((row) => row.ticker),
    ),
  ];
}
