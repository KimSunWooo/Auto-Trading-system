import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BudgetMode, ConditionKind, UserRule } from "@/src/rules/params";
import { blankRule } from "@/src/rules/params";
import { AdminPresetBar } from "@/components/admin-preset-bar";
import { InstrumentSearch } from "@/components/stock-select";

export type RuleDraft = {
  ticker: string;
  instrumentId?: string;
  instrumentKey?: string;
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
  allocationPct: string;
  budgetMode: BudgetMode;
  enabled: boolean;
};

function parseFiniteNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function emptyDraft(): RuleDraft {
  return {
    ticker: "",
    instrumentId: undefined,
    instrumentKey: undefined,
    name: "",
    kind: "interval",
    intervalSec: "",
    fastMa: "",
    slowMa: "",
    buyPct: "",
    sliceKrw: "",
    stopLossPct: "",
    takeProfitPct: "",
    budget: "",
    allocationPct: "",
    budgetMode: "orderable_ratio",
    enabled: true,
  };
}

export function ruleToDraft(rule?: Partial<UserRule> | null): RuleDraft {
  if (!rule || !rule.ticker) return emptyDraft();
  const base = blankRule(rule);
  const mode = base.budgetMode ?? "orderable_ratio";
  return {
    ticker: base.ticker,
    instrumentId: base.instrumentId,
    instrumentKey: base.instrumentKey,
    name: base.name,
    kind: base.kind,
    intervalSec: String(Math.round(base.intervalMs / 1000)),
    fastMa: String(base.fastMa),
    slowMa: String(base.slowMa),
    buyPct: String(Math.round(base.buyPct * 100)),
    sliceKrw: String(base.sliceKrw),
    stopLossPct: String(Math.round(base.stopLossPct * 100)),
    takeProfitPct: String(Math.round(base.takeProfitPct * 100)),
    budget: base.budget > 0 ? String(base.budget) : "",
    allocationPct:
      base.allocationPct != null ? String(Math.round(base.allocationPct * 1000) / 10) : "",
    budgetMode: mode,
    enabled: base.enabled,
  };
}

export type DraftValidation = {
  ok: boolean;
  errors: Partial<Record<keyof RuleDraft | "form", string>>;
  rule: UserRule | null;
};

export function validateDraft(
  draft: RuleDraft,
  opts?: { remainingAllocationPct?: number; excludeRuleId?: string },
): DraftValidation {
  const errors: DraftValidation["errors"] = {};
  const intervalSec = parseFiniteNumber(draft.intervalSec);
  const fastMa = parseFiniteNumber(draft.fastMa);
  const slowMa = parseFiniteNumber(draft.slowMa);
  const buyPctPct = parseFiniteNumber(draft.buyPct);
  const sliceKrw = parseFiniteNumber(draft.sliceKrw);
  const stopLossPct = parseFiniteNumber(draft.stopLossPct);
  const takeProfitPct = parseFiniteNumber(draft.takeProfitPct);
  const budget = parseFiniteNumber(draft.budget);
  const allocationPctPct = parseFiniteNumber(draft.allocationPct);

  if (!/^\d{6}$/.test(draft.ticker.replace(/\D/g, "").slice(-6).padStart(6, "0")) && draft.ticker) {
    errors.ticker = "종목코드 6자리가 필요합니다.";
  }
  if (!draft.ticker.trim()) errors.ticker = "종목코드 6자리가 필요합니다.";

  if (draft.kind === "interval") {
    if (intervalSec == null || intervalSec < 1) errors.intervalSec = "평가 주기는 1초 이상이어야 합니다.";
  } else {
    if (fastMa == null || fastMa < 1) errors.fastMa = "단기 이평이 필요합니다.";
    if (slowMa == null || slowMa < 1) errors.slowMa = "장기 이평이 필요합니다.";
    if (fastMa != null && slowMa != null && fastMa >= slowMa) {
      errors.slowMa = "단기 이평은 장기 이평보다 짧아야 합니다.";
    }
  }

  if (buyPctPct == null || buyPctPct <= 0 || buyPctPct > 100) {
    errors.buyPct = "1회 매수 비율은 0 초과 100 이하여야 합니다.";
  }
  if (sliceKrw == null || sliceKrw < 0) errors.sliceKrw = "1회 상한 금액이 올바르지 않습니다.";
  if (stopLossPct == null || stopLossPct <= 0 || stopLossPct > 100) {
    errors.stopLossPct = "손절 비율이 올바르지 않습니다.";
  }
  if (takeProfitPct == null || takeProfitPct < 0 || takeProfitPct > 100) {
    errors.takeProfitPct = "익절 비율이 올바르지 않습니다.";
  }

  if (draft.budgetMode === "orderable_ratio") {
    if (allocationPctPct == null || allocationPctPct < 0 || allocationPctPct > 100) {
      errors.allocationPct = "전략 배정 비율은 0~100%여야 합니다.";
    } else if (
      opts?.remainingAllocationPct != null &&
      allocationPctPct / 100 > opts.remainingAllocationPct + 1e-9
    ) {
      errors.allocationPct = `남은 배정 비율 ${(opts.remainingAllocationPct * 100).toFixed(1)}%를 초과합니다.`;
    }
  } else if (budget == null || budget < 0) {
    errors.budget = "고정 예산이 올바르지 않습니다.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, rule: null };
  }

  const rule = blankRule({
    name: draft.name,
    ticker: draft.ticker,
    instrumentId: draft.instrumentId,
    instrumentKey: draft.instrumentKey,
    kind: draft.kind,
    intervalMs: Math.max(1, intervalSec ?? 60) * 1000,
    fastMa: fastMa ?? 5,
    slowMa: slowMa ?? 20,
    buyPct: (buyPctPct ?? 10) / 100,
    sliceKrw: sliceKrw ?? 100_000,
    stopLossPct: (stopLossPct ?? 5) / 100,
    takeProfitPct: (takeProfitPct ?? 3) / 100,
    budget: budget ?? 0,
    allocationPct: draft.budgetMode === "orderable_ratio" ? (allocationPctPct ?? 0) / 100 : undefined,
    budgetMode: draft.budgetMode,
    enabled: draft.enabled,
  });
  return { ok: true, errors: {}, rule };
}

/** @deprecated prefer validateDraft — kept for callers that need a rule object. */
export function draftToRule(draft: RuleDraft, id?: string): UserRule {
  const v = validateDraft(draft);
  if (v.rule) return id ? { ...v.rule, id } : v.rule;
  // Fall through with strict zeros rather than inventing amounts via || defaults.
  return blankRule({
    id,
    name: draft.name,
    ticker: draft.ticker,
    instrumentId: draft.instrumentId,
    instrumentKey: draft.instrumentKey,
    kind: draft.kind,
    intervalMs: Math.max(1, parseFiniteNumber(draft.intervalSec) ?? 60) * 1000,
    fastMa: parseFiniteNumber(draft.fastMa) ?? 5,
    slowMa: parseFiniteNumber(draft.slowMa) ?? 20,
    buyPct: (parseFiniteNumber(draft.buyPct) ?? 10) / 100,
    sliceKrw: parseFiniteNumber(draft.sliceKrw) ?? 100_000,
    stopLossPct: (parseFiniteNumber(draft.stopLossPct) ?? 5) / 100,
    takeProfitPct: (parseFiniteNumber(draft.takeProfitPct) ?? 3) / 100,
    budget: parseFiniteNumber(draft.budget) ?? 0,
    allocationPct:
      draft.budgetMode === "orderable_ratio"
        ? (parseFiniteNumber(draft.allocationPct) ?? 0) / 100
        : undefined,
    budgetMode: draft.budgetMode,
    enabled: draft.enabled,
  });
}

export function RuleBuilder({
  value,
  onChange,
  showEnable = true,
  remainingAllocationPct,
  fieldErrors,
}: {
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
  showEnable?: boolean;
  remainingAllocationPct?: number;
  fieldErrors?: DraftValidation["errors"];
}) {
  function patch(next: Partial<RuleDraft>) {
    onChange({ ...value, ...next });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AdminPresetBar currentTicker={value.ticker} onApply={(next) => onChange({ ...value, ...next })} />
      <Field label="종목 (코드·이름 검색)" error={fieldErrors?.ticker}>
        <InstrumentSearch
          value={value.ticker}
          legacySixDigitOnly
          country="KR"
          placeholder="종목코드 6자리 또는 종목명"
          onChange={(ticker, pick) =>
            patch({
              ticker,
              instrumentId: pick?.instrumentId,
              instrumentKey: pick?.instrumentKey,
            })
          }
        />
      </Field>
      <Field label="조건식 이름 (선택)">
        <Input
          placeholder="예: 내 이평 조건"
          value={value.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      <Field label="매수 조건">
        <select
          className="h-8 w-full rounded-lg border bg-transparent px-2.5 text-sm"
          value={value.kind}
          onChange={(event) => patch({ kind: event.target.value as ConditionKind })}
        >
          <option value="interval">실행 주기마다 분할 매수</option>
          <option value="ma-cross">단기 이평이 장기 이평을 상향 돌파하면 매수</option>
        </select>
      </Field>
      {value.kind === "interval" ? (
        <Field
          label="조건 평가 주기 (초) — 매수 허용 주기와 별개"
          error={fieldErrors?.intervalSec}
        >
          <Input
            inputMode="numeric"
            value={value.intervalSec}
            onChange={(event) => patch({ intervalSec: event.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field label="단기 이평 (일)" error={fieldErrors?.fastMa}>
            <Input
              inputMode="numeric"
              value={value.fastMa}
              onChange={(event) => patch({ fastMa: event.target.value })}
            />
          </Field>
          <Field label="장기 이평 (일)" error={fieldErrors?.slowMa}>
            <Input
              inputMode="numeric"
              value={value.slowMa}
              onChange={(event) => patch({ slowMa: event.target.value })}
            />
          </Field>
        </>
      )}
      <Field label="전략 배정 방식">
        <select
          className="h-8 w-full rounded-lg border bg-transparent px-2.5 text-sm"
          value={value.budgetMode}
          onChange={(event) => patch({ budgetMode: event.target.value as BudgetMode })}
        >
          <option value="orderable_ratio">주문가능금액 비율 (권장)</option>
          <option value="legacy_fixed">고정 금액 (레거시)</option>
        </select>
      </Field>
      {value.budgetMode === "orderable_ratio" ? (
        <Field
          label={`전략 배정 비율 (%) — 남은 ${(
            (remainingAllocationPct ?? 1) * 100
          ).toFixed(1)}%`}
          error={fieldErrors?.allocationPct}
        >
          <Input
            inputMode="decimal"
            value={value.allocationPct}
            onChange={(event) => patch({ allocationPct: event.target.value })}
          />
        </Field>
      ) : (
        <Field label="이 조건식에 배정할 고정 예수금 (원)" error={fieldErrors?.budget}>
          <Input
            inputMode="numeric"
            placeholder="0"
            value={value.budget}
            onChange={(event) => patch({ budget: event.target.value })}
          />
        </Field>
      )}
      <Field label="1회 매수 비율 (% of 전략 매수가능금액)" error={fieldErrors?.buyPct}>
        <Input
          inputMode="decimal"
          value={value.buyPct}
          onChange={(event) => patch({ buyPct: event.target.value })}
        />
      </Field>
      <Field label="1회 매수 상한 (원, 선택)" error={fieldErrors?.sliceKrw}>
        <Input
          inputMode="numeric"
          value={value.sliceKrw}
          onChange={(event) => patch({ sliceKrw: event.target.value })}
        />
      </Field>
      <Field label="손절 라인 (평단 대비 %, 음수는 입력하지 않음)" error={fieldErrors?.stopLossPct}>
        <Input
          inputMode="decimal"
          value={value.stopLossPct}
          onChange={(event) => patch({ stopLossPct: event.target.value })}
        />
      </Field>
      <Field label="익절 라인 (평단 대비 %)" error={fieldErrors?.takeProfitPct}>
        <Input
          inputMode="decimal"
          value={value.takeProfitPct}
          onChange={(event) => patch({ takeProfitPct: event.target.value })}
        />
      </Field>
      {showEnable ? (
        <div className="flex items-center justify-between rounded-lg border px-3 py-2 sm:col-span-2">
          <Label>이 조건식 사용</Label>
          <Switch checked={value.enabled} onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })} />
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
