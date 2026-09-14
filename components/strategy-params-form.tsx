"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-trading";
import type { PublicState } from "@/lib/types";
import {
  DEFAULT_STRATEGY_CONFIG,
  mergeStrategyConfig,
  validateStrategyConfig,
  type StrategyConfigFile,
} from "@/src/strategies/params";

type Draft = {
  Level1_Stable: {
    ticker: string;
    intervalSec: string;
    sliceKrw: string;
    slicePct: string;
    minAmountKrw: string;
  };
  Level5_Swing: {
    ticker: string;
    fastMa: string;
    slowMa: string;
    buyPct: string;
  };
  Level10_Aggressive: {
    universe: string;
    cooldownSec: string;
    k: string;
    minDayReturn: string;
    buyPct: string;
  };
};

function pctDisplay(value: number, digits = 4): string {
  return String(Number((value * 100).toFixed(digits)));
}

function configToDraft(config: StrategyConfigFile): Draft {
  return {
    Level1_Stable: {
      ticker: config.Level1_Stable.ticker,
      intervalSec: String(Math.round(config.Level1_Stable.intervalMs / 1000)),
      sliceKrw: String(config.Level1_Stable.sliceKrw),
      slicePct: pctDisplay(config.Level1_Stable.slicePct),
      minAmountKrw: String(config.Level1_Stable.minAmountKrw),
    },
    Level5_Swing: {
      ticker: config.Level5_Swing.ticker,
      fastMa: String(config.Level5_Swing.fastMa),
      slowMa: String(config.Level5_Swing.slowMa),
      buyPct: pctDisplay(config.Level5_Swing.buyPct),
    },
    Level10_Aggressive: {
      universe: config.Level10_Aggressive.universe.join(", "),
      cooldownSec: String(Math.round(config.Level10_Aggressive.cooldownMs / 1000)),
      k: String(config.Level10_Aggressive.k),
      minDayReturn: pctDisplay(config.Level10_Aggressive.minDayReturn),
      buyPct: pctDisplay(config.Level10_Aggressive.buyPct),
    },
  };
}

function requiredNumber(value: string, label: string): number {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n)) {
    throw new Error(`${label}을(를) 입력하세요.`);
  }
  return n;
}

function draftToPayload(draft: Draft): unknown {
  return {
    Level1_Stable: {
      ticker: draft.Level1_Stable.ticker,
      intervalMs: requiredNumber(draft.Level1_Stable.intervalSec, "Level1 매수 주기") * 1000,
      sliceKrw: requiredNumber(draft.Level1_Stable.sliceKrw, "Level1 슬라이스 금액"),
      slicePct: requiredNumber(draft.Level1_Stable.slicePct, "Level1 버킷 비율") / 100,
      minAmountKrw: requiredNumber(draft.Level1_Stable.minAmountKrw, "Level1 최소 금액"),
    },
    Level5_Swing: {
      ticker: draft.Level5_Swing.ticker,
      fastMa: requiredNumber(draft.Level5_Swing.fastMa, "Level5 단기 이평"),
      slowMa: requiredNumber(draft.Level5_Swing.slowMa, "Level5 장기 이평"),
      buyPct: requiredNumber(draft.Level5_Swing.buyPct, "Level5 매수 비중") / 100,
    },
    Level10_Aggressive: {
      universe: draft.Level10_Aggressive.universe,
      cooldownMs: requiredNumber(draft.Level10_Aggressive.cooldownSec, "Level10 쿨다운") * 1000,
      k: requiredNumber(draft.Level10_Aggressive.k, "Level10 K값"),
      minDayReturn: requiredNumber(draft.Level10_Aggressive.minDayReturn, "Level10 최소 당일수익률") / 100,
      buyPct: requiredNumber(draft.Level10_Aggressive.buyPct, "Level10 매수 비중") / 100,
    },
  };
}

function digitsTicker(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function StrategyParamsForm({
  config,
  onState,
}: {
  config: StrategyConfigFile;
  onState: (next: PublicState) => void;
}) {
  const [saved, setSaved] = useState<StrategyConfigFile>(config);
  const [draft, setDraft] = useState<Draft>(() => configToDraft(config));
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  const appliedRef = useRef(JSON.stringify(config));

  const savedDraft = useMemo(() => configToDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  dirtyRef.current = dirty;

  useEffect(() => {
    const next = JSON.stringify(config);
    if (dirtyRef.current) return;
    if (next === appliedRef.current) return;
    appliedRef.current = next;
    setSaved(config);
    setDraft(configToDraft(config));
  }, [config]);

  function updateL1(patch: Partial<Draft["Level1_Stable"]>) {
    setDraft((current) => ({ ...current, Level1_Stable: { ...current.Level1_Stable, ...patch } }));
  }
  function updateL5(patch: Partial<Draft["Level5_Swing"]>) {
    setDraft((current) => ({ ...current, Level5_Swing: { ...current.Level5_Swing, ...patch } }));
  }
  function updateL10(patch: Partial<Draft["Level10_Aggressive"]>) {
    setDraft((current) => ({
      ...current,
      Level10_Aggressive: { ...current.Level10_Aggressive, ...patch },
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      const merged = mergeStrategyConfig(payload);
      const invalid = validateStrategyConfig(merged);
      if (invalid) throw new Error(invalid);
      const next = await api<PublicState>("/api/strategy-config", {
        method: "PUT",
        body: JSON.stringify(merged),
      });
      onState(next);
      appliedRef.current = JSON.stringify(next.strategyConfig);
      setSaved(next.strategyConfig);
      setDraft(configToDraft(next.strategyConfig));
      toast.success("전략 파라미터를 저장했습니다. 다음 틱부터 반영됩니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(configToDraft(saved));
  }

  function restoreDefaults() {
    setDraft(configToDraft(DEFAULT_STRATEGY_CONFIG));
  }

  const l1 = draft.Level1_Stable;
  const l5 = draft.Level5_Swing;
  const l10 = draft.Level10_Aggressive;

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontalIcon className="size-4" />
              전략 파라미터
            </CardTitle>
            <CardDescription>
              종목·주기·슬라이스·이평·K값·쿨다운을 화면에서 바꿉니다. 저장하면{" "}
              <code className="rounded bg-muted px-1">data/strategy-config.json</code> 에 기록되고
              세 전략이 같이 읽습니다. 한 버킷만 다르게 쓰려면{" "}
              <code className="rounded bg-muted px-1">meta</code> 의 같은 키로 덮어쓰세요.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={restoreDefaults}>
              기본값
            </Button>
            <Button variant="outline" onClick={discard} disabled={!dirty || saving}>
              되돌리기
            </Button>
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "저장 중" : "설정 저장"}
            </Button>
          </div>
        </div>
        {dirty ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            저장하지 않은 변경이 있습니다. 시세 틱이 돌아도 입력값은 유지됩니다.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-6 pt-4">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level1 안정 적립</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="종목코드" hint="숫자 6자리">
              <Input
                inputMode="numeric"
                maxLength={6}
                value={l1.ticker}
                onChange={(e) => updateL1({ ticker: digitsTicker(e.target.value) })}
              />
            </Field>
            <Field label="매수 주기 (초)">
              <Input
                inputMode="decimal"
                value={l1.intervalSec}
                onChange={(e) => updateL1({ intervalSec: e.target.value })}
              />
            </Field>
            <Field label="슬라이스 금액 (원)">
              <Input
                inputMode="numeric"
                value={l1.sliceKrw}
                onChange={(e) => updateL1({ sliceKrw: e.target.value })}
              />
            </Field>
            <Field label="버킷 비율 (%)">
              <Input
                inputMode="decimal"
                value={l1.slicePct}
                onChange={(e) => updateL1({ slicePct: e.target.value })}
              />
            </Field>
            <Field label="최소 금액 (원)">
              <Input
                inputMode="numeric"
                value={l1.minAmountKrw}
                onChange={(e) => updateL1({ minAmountKrw: e.target.value })}
              />
            </Field>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level5 이평 스윙</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="종목코드" hint="숫자 6자리">
              <Input
                inputMode="numeric"
                maxLength={6}
                value={l5.ticker}
                onChange={(e) => updateL5({ ticker: digitsTicker(e.target.value) })}
              />
            </Field>
            <Field label="단기 이평">
              <Input
                inputMode="numeric"
                value={l5.fastMa}
                onChange={(e) => updateL5({ fastMa: e.target.value })}
              />
            </Field>
            <Field label="장기 이평">
              <Input
                inputMode="numeric"
                value={l5.slowMa}
                onChange={(e) => updateL5({ slowMa: e.target.value })}
              />
            </Field>
            <Field label="매수 비중 (%)">
              <Input
                inputMode="decimal"
                value={l5.buyPct}
                onChange={(e) => updateL5({ buyPct: e.target.value })}
              />
            </Field>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level10 변동성 추격</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label="유니버스" hint="쉼표 또는 공백으로 종목코드를 구분합니다.">
                <Input
                  value={l10.universe}
                  onChange={(e) => updateL10({ universe: e.target.value })}
                />
              </Field>
            </div>
            <Field label="쿨다운 (초)">
              <Input
                inputMode="decimal"
                value={l10.cooldownSec}
                onChange={(e) => updateL10({ cooldownSec: e.target.value })}
              />
            </Field>
            <Field label="K값">
              <Input
                inputMode="decimal"
                value={l10.k}
                onChange={(e) => updateL10({ k: e.target.value })}
              />
            </Field>
            <Field label="최소 당일수익률 (%)">
              <Input
                inputMode="decimal"
                value={l10.minDayReturn}
                onChange={(e) => updateL10({ minDayReturn: e.target.value })}
              />
            </Field>
            <Field label="매수 비중 (%)">
              <Input
                inputMode="decimal"
                value={l10.buyPct}
                onChange={(e) => updateL10({ buyPct: e.target.value })}
              />
            </Field>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
