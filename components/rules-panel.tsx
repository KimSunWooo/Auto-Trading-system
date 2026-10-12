"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { PublicState } from "@/lib/types";
import {
  RuleBuilder,
  emptyDraft,
  validateDraft,
  type RuleDraft,
} from "@/components/rule-builder";
import { BacktestPreview } from "@/components/backtest-preview";
import type { UserRule } from "@/src/rules/params";

function maskAccount(masked?: string | null): string {
  if (!masked) return "PAPER ·••••";
  return `PAPER ${masked}`;
}

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
  const [serverError, setServerError] = useState<string | null>(null);

  const orderable =
    state.kisBalance?.orderableCash ?? state.runtime?.accountSnapshot?.orderableCash ?? null;
  const deposit = state.kisBalance?.cash ?? state.runtime?.accountSnapshot?.cash ?? null;
  const freshness = state.kisBalance?.freshness ?? "unknown";
  const syncedAt = state.kisBalance?.syncedAt ?? state.kisBalance?.fetchedAt ?? null;

  const activePctSum = rules
    .filter((r) => r.enabled && (r.budgetMode === "orderable_ratio" || r.allocationPct != null))
    .reduce((sum, r) => sum + Math.max(0, r.allocationPct ?? 0), 0);
  const remainingPct = Math.max(0, 1 - activePctSum);

  const draftValidation = useMemo(
    () => validateDraft(draft, { remainingAllocationPct: remainingPct }),
    [draft, remainingPct],
  );

  async function saveRules(next: UserRule[]): Promise<boolean> {
    setSaving(true);
    setServerError(null);
    try {
      onState(
        await api<PublicState>("/api/strategy-config", {
          method: "PUT",
          body: JSON.stringify({
            rules: next,
            version: state.ruleConfig?.version,
          }),
        }),
      );
      toast.success("사용자 설정을 저장했습니다.");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "저장하지 못했습니다.";
      setServerError(msg);
      toast.error(msg);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addRule() {
    if (!draftValidation.ok || !draftValidation.rule) {
      toast.error(Object.values(draftValidation.errors)[0] ?? "입력을 확인하세요.");
      return;
    }
    const ok = await saveRules([...rules, draftValidation.rule]);
    if (ok) setDraft(emptyDraft());
  }

  async function removeRule(id: string) {
    const target = rules.find((r) => r.id === id);
    if (!target) return;
    const hasPos = state.positions.some((p) => p.ruleId === id && p.qty > 0);
    const hasOpen = state.orders.some(
      (o) =>
        o.ruleId === id &&
        (o.status === "pending" || o.status === "unknown" || o.activeClass === "UNKNOWN_ACTIVE"),
    );
    if (hasPos || hasOpen) {
      toast.error("보유분 또는 미해결 주문이 있어 삭제할 수 없습니다. 비활성화하세요.");
      return;
    }
    await saveRules(rules.filter((row) => row.id !== id));
  }

  async function toggleRule(id: string, enabled: boolean) {
    const next = rules.map((row) => (row.id === id ? { ...row, enabled } : row));
    if (enabled) {
      const sum = next
        .filter((r) => r.enabled && (r.budgetMode === "orderable_ratio" || r.allocationPct != null))
        .reduce((s, r) => s + Math.max(0, r.allocationPct ?? 0), 0);
      if (sum > 1 + 1e-9) {
        toast.error("활성 전략 배정 비율 합계가 100%를 초과합니다.");
        return;
      }
    }
    await saveRules(next);
  }

  async function convertLegacy(ruleId: string) {
    setSaving(true);
    setServerError(null);
    try {
      onState(
        await api<PublicState>("/api/strategy-config", {
          method: "PATCH",
          body: JSON.stringify({ action: "convert_legacy_to_ratio", ruleId }),
        }),
      );
      toast.success("비율 방식으로 전환했습니다. (autoTrading 변경 없음)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "전환에 실패했습니다.";
      setServerError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const autoOff = state.settings.autoTrading !== true;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>계좌·예산 현황</CardTitle>
          <CardDescription>
            {maskAccount(state.broker?.accountMasked)}
            {" · "}
            autoTrading {autoOff ? "OFF — 평가만 수행, 실제 주문 없음" : "ON"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div>예수금: {deposit == null ? "조회 없음" : formatWon(deposit)}</div>
          <div>
            주문가능금액:{" "}
            {orderable == null ? "조회 없음/실패 (0원으로 가장하지 않음)" : formatWon(orderable)}
          </div>
          <div>
            신선도: {freshness}
            {syncedAt ? ` · ${syncedAt}` : ""}
          </div>
          <div>
            배정 합계 {(activePctSum * 100).toFixed(1)}% · 남은 {(remainingPct * 100).toFixed(1)}%
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>매매 룰 추가</CardTitle>
          <CardDescription>
            전략 배정 비율과 1회 매수 비율은 별개입니다. 평가 주기와 실제 매수 허용 주기도 다릅니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RuleBuilder
            value={draft}
            onChange={setDraft}
            remainingAllocationPct={remainingPct}
            fieldErrors={draftValidation.errors}
          />
          {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          <Button
            onClick={() => void addRule()}
            disabled={saving || !draftValidation.ok}
          >
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
            const isLongSoak = rule.id === "paper-long-soak-ma";
            const mode = rule.budgetMode ?? (rule.allocationPct != null ? "orderable_ratio" : "legacy_fixed");
            const computed =
              mode === "orderable_ratio" && orderable != null && rule.allocationPct != null
                ? Math.floor(orderable * rule.allocationPct)
                : rule.budget;
            return (
              <div key={rule.id} className="space-y-2 rounded-xl border px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {rule.name || "이름 없음"} · {rule.ticker}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {rule.kind === "interval"
                        ? `평가 주기 ${Math.round(rule.intervalMs / 1000)}초`
                        : `이평 ${rule.fastMa}/${rule.slowMa}`}
                      {rule.kind === "ma-cross" ? " · MA source = Daily" : null}
                      {" · "}1회 매수 {Math.round(rule.buyPct * 100)}% / 상한 {formatWon(rule.sliceKrw)}
                      {mode === "orderable_ratio" ? (
                        <>
                          {" · "}배정 {((rule.allocationPct ?? 0) * 100).toFixed(1)}%
                          {" → "}한도 {formatWon(computed)}
                        </>
                      ) : (
                        <>
                          {" · "}고정 예산 {formatWon(rule.budget)}
                        </>
                      )}
                      {" · "}손절 {Math.round(rule.stopLossPct * 100)}% · 익절{" "}
                      {Math.round(rule.takeProfitPct * 100)}%
                      {isLongSoak ? " · Max Qty = 5" : null}
                    </p>
                    {isLongSoak ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        PAPER Long Soak baseline — Enabled OFF. Lifecycle validation only; not an
                        optimized strategy.
                      </p>
                    ) : null}
                    {alloc?.lastMessage ? (
                      <p className="mt-1 text-xs text-muted-foreground">{alloc.lastMessage}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {mode === "legacy_fixed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => void convertLegacy(rule.id)}
                      >
                        비율 전환
                      </Button>
                    ) : null}
                    <Badge variant={rule.enabled ? "default" : "secondary"}>
                      {rule.enabled ? "사용" : "Enabled OFF"}
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
