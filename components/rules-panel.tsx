"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { PublicState } from "@/lib/types";
import { RuleBuilder, draftToRule, emptyDraft, type RuleDraft } from "@/components/rule-builder";
import { BacktestPreview } from "@/components/backtest-preview";
import type { UserRule } from "@/src/rules/params";

export function RulesPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  const rules = state.ruleConfig?.rules ?? [];
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);

  async function saveRules(next: UserRule[]) {
    setSaving(true);
    try {
      onState(
        await api<PublicState>("/api/strategy-config", {
          method: "PUT",
          body: JSON.stringify({ rules: next }),
        }),
      );
      toast.success("사용자 설정을 저장했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  async function addRule() {
    const rule = draftToRule(draft);
    if (!rule.ticker) {
      toast.error("종목코드 6자리를 입력하세요.");
      return;
    }
    await saveRules([...rules, rule]);
    setDraft(emptyDraft());
  }

  async function removeRule(id: string) {
    await saveRules(rules.filter((row) => row.id !== id));
  }

  async function toggleRule(id: string, enabled: boolean) {
    await saveRules(rules.map((row) => (row.id === id ? { ...row, enabled } : row)));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>매매 룰 추가</CardTitle>
          <CardDescription>
            종목·조건·금액·손익 라인을 직접 입력합니다. 미리 정해 둔 종목이나 템플릿은 없습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RuleBuilder value={draft} onChange={setDraft} />
          <Button onClick={() => void addRule()} disabled={saving}>
            조건식 저장
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>저장된 조건식</CardTitle>
          <CardDescription>
            {rules.length === 0
              ? "아직 없습니다. 위에서 종목코드와 조건을 넣으면 실행 주기에 따라 API 주문을 냅니다."
              : `${rules.length}개`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rules.map((rule) => {
            const alloc = state.allocations.find((row) => row.ruleId === rule.id);
            return (
              <div key={rule.id} className="space-y-2 rounded-xl border px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {rule.name || "이름 없음"} · {rule.ticker}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {rule.kind === "interval"
                        ? `실행 주기 ${Math.round(rule.intervalMs / 1000)}초`
                        : `이평 ${rule.fastMa}/${rule.slowMa}`}
                      {" · "}1회 {Math.round(rule.buyPct * 100)}% / {formatWon(rule.sliceKrw)}
                      {" · "}손절 {Math.round(rule.stopLossPct * 100)}% · 익절{" "}
                      {Math.round(rule.takeProfitPct * 100)}%
                    </p>
                    {alloc?.lastMessage ? (
                      <p className="mt-1 text-xs text-muted-foreground">{alloc.lastMessage}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={rule.enabled ? "default" : "secondary"}>
                      {rule.enabled ? "사용" : "중지"}
                    </Badge>
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(checked) => void toggleRule(rule.id, Boolean(checked))}
                    />
                    <Button size="sm" variant="outline" onClick={() => void removeRule(rule.id)}>
                      삭제
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>조건식 재생 (로컬)</CardTitle>
          <CardDescription>
            저장한 조건식을 과거 일봉에 기계적으로 다시 돌립니다. 미래 수익을 보여 주지 않습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BacktestPreview totalDeposit={state.totalDeposit} years={1} />
        </CardContent>
      </Card>
    </div>
  );
}
