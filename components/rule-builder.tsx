import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ConditionKind, UserRule } from "@/src/rules/params";
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
  enabled: boolean;
};

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
    enabled: true,
  };
}

export function ruleToDraft(rule?: Partial<UserRule> | null): RuleDraft {
  if (!rule || !rule.ticker) return emptyDraft();
  const base = blankRule(rule);
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
    budget: String(base.budget || ""),
    enabled: base.enabled,
  };
}

export function draftToRule(draft: RuleDraft, id?: string): UserRule {
  return blankRule({
    id,
    name: draft.name,
    ticker: draft.ticker,
    instrumentId: draft.instrumentId,
    instrumentKey: draft.instrumentKey,
    kind: draft.kind,
    intervalMs: Math.max(1, Number(draft.intervalSec) || 60) * 1000,
    fastMa: Number(draft.fastMa) || 5,
    slowMa: Number(draft.slowMa) || 20,
    buyPct: (Number(draft.buyPct) || 10) / 100,
    sliceKrw: Number(draft.sliceKrw) || 100_000,
    stopLossPct: (Number(draft.stopLossPct) || 5) / 100,
    takeProfitPct: (Number(draft.takeProfitPct) || 3) / 100,
    budget: Number(draft.budget) || 0,
    enabled: draft.enabled,
  });
}

export function RuleBuilder({
  value,
  onChange,
  showEnable = true,
}: {
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
  showEnable?: boolean;
}) {
  function patch(next: Partial<RuleDraft>) {
    onChange({ ...value, ...next });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AdminPresetBar currentTicker={value.ticker} onApply={(next) => onChange({ ...value, ...next })} />
      <Field label="종목 (코드·이름 검색)">
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
        <Field label="실행 주기 (초)">
          <Input
            inputMode="numeric"
            value={value.intervalSec}
            onChange={(event) => patch({ intervalSec: event.target.value })}
          />
        </Field>
      ) : (
        <>
          <Field label="단기 이평 (일)">
            <Input
              inputMode="numeric"
              value={value.fastMa}
              onChange={(event) => patch({ fastMa: event.target.value })}
            />
          </Field>
          <Field label="장기 이평 (일)">
            <Input
              inputMode="numeric"
              value={value.slowMa}
              onChange={(event) => patch({ slowMa: event.target.value })}
            />
          </Field>
        </>
      )}
      <Field label="1회 매수 비중 (%)">
        <Input
          inputMode="decimal"
          value={value.buyPct}
          onChange={(event) => patch({ buyPct: event.target.value })}
        />
      </Field>
      <Field label="1회 매수 상한 (원)">
        <Input
          inputMode="numeric"
          value={value.sliceKrw}
          onChange={(event) => patch({ sliceKrw: event.target.value })}
        />
      </Field>
      <Field label="이 조건식에 배정할 예수금 (원)">
        <Input
          inputMode="numeric"
          placeholder="0"
          value={value.budget}
          onChange={(event) => patch({ budget: event.target.value })}
        />
      </Field>
      <Field label="손절 라인 (평단 대비 %, 음수는 입력하지 않음)">
        <Input
          inputMode="decimal"
          value={value.stopLossPct}
          onChange={(event) => patch({ stopLossPct: event.target.value })}
        />
      </Field>
      <Field label="익절 라인 (평단 대비 %)">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
