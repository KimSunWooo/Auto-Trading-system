"use client";

import { useState } from "react";
import { toast } from "sonner";
import { GaugeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { Allocation, PublicState } from "@/lib/types";
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfigFile } from "@/src/strategies/params";

function playbook(level: number, config: StrategyConfigFile): string {
  if (level <= 3) return `${config.Level1_Stable.ticker} 정액 적립`;
  if (level <= 7) return `${config.Level5_Swing.ticker} 이평 스윙`;
  return "변동성 돌파 추격";
}

export function StrategiesPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  async function toggle(row: Allocation, enabled: boolean) {
    onState(
      await api<PublicState>("/api/allocations", {
        method: "PATCH",
        body: JSON.stringify({ strategy: row.strategy, enabled }),
      }),
    );
  }

  async function restoreSplit() {
    try {
      onState(
        await api<PublicState>("/api/allocations", {
          method: "POST",
          body: JSON.stringify({
            allocations: [
              { strategy: "Level1_Stable", riskLevel: 1, budget: 7_000_000 },
              { strategy: "Level5_Swing", riskLevel: 5, budget: 0, enabled: false },
              { strategy: "Level10_Aggressive", riskLevel: 10, budget: 3_000_000 },
            ],
          }),
        }),
      );
      toast.success("70/30 배분으로 재설정했습니다. 잔고는 초기화됩니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "재배분에 실패했습니다.");
    }
  }

  async function enableSwing() {
    const rest = state.allocations.filter((a) => a.strategy !== "Level5_Swing");
    const used = rest.reduce((s, a) => s + a.budget, 0);
    const leftover = Math.max(0, state.totalDeposit - used);
    if (leftover < 100_000) {
      toast.error("스윙 버킷을 넣을 여유 예수금이 없습니다. 먼저 70/30을 재설정하세요.");
      return;
    }
    try {
      onState(
        await api<PublicState>("/api/allocations", {
          method: "POST",
          body: JSON.stringify({
            allocations: [
              ...rest.map((a) => ({
                strategy: a.strategy,
                riskLevel: a.riskLevel,
                budget: a.budget,
                enabled: a.enabled,
              })),
              { strategy: "Level5_Swing", riskLevel: 5, budget: leftover, enabled: true },
            ],
          }),
        }),
      );
      toast.success("리스크 5 스윙 버킷을 추가했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "추가에 실패했습니다.");
    }
  }

  const hasSwing = state.allocations.some((a) => a.strategy === "Level5_Swing");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <GaugeIcon className="size-4" />
                전략 버킷
              </CardTitle>
              <CardDescription>
                총 예수금 {formatWon(state.totalDeposit)}을 전략별로 나눠 씁니다. 각 전략은 자기
                잔액 안에서만 주문합니다. 통과한 주문은{" "}
                {state.broker?.driver === "kis" ? "한국투자증권" : "로컬 페이퍼 북"}으로 전달됩니다.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {!hasSwing ? (
                <Button variant="outline" onClick={() => void enableSwing()}>
                  리스크5 스윙 추가
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => void restoreSplit()}>
                70/30 재설정
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-2">
          {state.allocations.map((row) => {
            const used = Math.max(0, row.budget - row.balance);
            const pct = row.budget > 0 ? Math.min(100, (used / row.budget) * 100) : 0;
            return (
              <div key={row.strategy} className="rounded-xl border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{row.strategy}</div>
                    <p className="text-xs text-muted-foreground">
                      {playbook(row.riskLevel, state.strategyConfig ?? DEFAULT_STRATEGY_CONFIG)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">리스크 {row.riskLevel}</Badge>
                    <Switch
                      checked={row.enabled}
                      onCheckedChange={(checked) => void toggle(row, Boolean(checked))}
                    />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">배정</div>
                    <div className="tabular-nums">{formatWon(row.budget)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">가용</div>
                    <div className="tabular-nums">{formatWon(row.balance)}</div>
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {row.lastMessage ?? "아직 실행 기록이 없습니다. 시세 틱마다 조건만 맞으면 주문합니다."}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <StrategyParamsCard
        config={state.strategyConfig ?? DEFAULT_STRATEGY_CONFIG}
        onState={onState}
      />
      <Card>
        <CardHeader>
          <CardTitle>브로커</CardTitle>
          <CardDescription>
            전략은 IBroker만 봅니다. <code className="rounded bg-muted px-1">BROKER=kis</code> 와
            앱키를 넣으면 한국투자증권 모의·실전 주문이 나갑니다. 실전은{" "}
            <code className="rounded bg-muted px-1">KIS_LIVE_CONFIRM=I_UNDERSTAND</code> 가 필요합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <Label>현재 드라이버</Label>
            <p className="mt-1 font-medium text-foreground">
              {state.broker?.driver === "kis"
                ? state.broker.mode === "real"
                  ? state.broker.liveEnabled
                    ? "한국투자증권 실전"
                    : "한국투자증권 실전 (주문 잠금)"
                  : "한국투자증권 모의투자"
                : "MockBroker 로컬 모의체결"}
            </p>
          </div>
          <p className="text-muted-foreground">{state.broker?.message}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function StrategyParamsCard({
  config,
  onState,
}: {
  config: StrategyConfigFile;
  onState: (next: PublicState) => void;
}) {
  const [draft, setDraft] = useState<StrategyConfigFile>(config);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const next = await api<PublicState>("/api/strategy-config", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      onState(next);
      setDraft(next.strategyConfig);
      toast.success("전략 파라미터를 data/strategy-config.json 에 저장했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults() {
    setDraft(structuredClone(DEFAULT_STRATEGY_CONFIG));
  }

  const l1 = draft.Level1_Stable;
  const l5 = draft.Level5_Swing;
  const l10 = draft.Level10_Aggressive;

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>전략 파라미터</CardTitle>
            <CardDescription>
              종목·주기·슬라이스·이평·K값·쿨다운은 코드가 아니라{" "}
              <code className="rounded bg-muted px-1">data/strategy-config.json</code> 에
              있습니다. 버킷 <code className="rounded bg-muted px-1">meta</code>의 같은 키로
              한 전략만 덮어쓸 수 있습니다.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={restoreDefaults}>
              기본값
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "저장 중" : "설정 저장"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-4">
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level1 안정 적립</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="종목코드">
              <Input
                value={l1.ticker}
                onChange={(e) =>
                  setDraft({ ...draft, Level1_Stable: { ...l1, ticker: e.target.value } })
                }
              />
            </Field>
            <Field label="매수 주기 (초)">
              <Input
                type="number"
                min={1}
                value={Math.round(l1.intervalMs / 1000)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level1_Stable: { ...l1, intervalMs: Number(e.target.value) * 1000 },
                  })
                }
              />
            </Field>
            <Field label="슬라이스 금액 (원)">
              <Input
                type="number"
                min={1}
                value={l1.sliceKrw}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level1_Stable: { ...l1, sliceKrw: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label="버킷 비율 (%)">
              <Input
                type="number"
                min={0.1}
                step={0.1}
                value={Number((l1.slicePct * 100).toFixed(2))}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level1_Stable: { ...l1, slicePct: Number(e.target.value) / 100 },
                  })
                }
              />
            </Field>
            <Field label="최소 금액 (원)">
              <Input
                type="number"
                min={1}
                value={l1.minAmountKrw}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level1_Stable: { ...l1, minAmountKrw: Number(e.target.value) },
                  })
                }
              />
            </Field>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level5 이평 스윙</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="종목코드">
              <Input
                value={l5.ticker}
                onChange={(e) =>
                  setDraft({ ...draft, Level5_Swing: { ...l5, ticker: e.target.value } })
                }
              />
            </Field>
            <Field label="단기 이평">
              <Input
                type="number"
                min={1}
                value={l5.fastMa}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level5_Swing: { ...l5, fastMa: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label="장기 이평">
              <Input
                type="number"
                min={2}
                value={l5.slowMa}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level5_Swing: { ...l5, slowMa: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label="매수 비중 (%)">
              <Input
                type="number"
                min={1}
                step={1}
                value={Number((l5.buyPct * 100).toFixed(2))}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level5_Swing: { ...l5, buyPct: Number(e.target.value) / 100 },
                  })
                }
              />
            </Field>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Level10 변동성 추격</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label="유니버스 (쉼표 구분)">
                <Input
                  value={l10.universe.join(", ")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      Level10_Aggressive: {
                        ...l10,
                        universe: e.target.value.split(/[,\s]+/).filter(Boolean),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <Field label="쿨다운 (초)">
              <Input
                type="number"
                min={0}
                value={Math.round(l10.cooldownMs / 1000)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level10_Aggressive: { ...l10, cooldownMs: Number(e.target.value) * 1000 },
                  })
                }
              />
            </Field>
            <Field label="K값">
              <Input
                type="number"
                min={0.01}
                step={0.05}
                value={l10.k}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level10_Aggressive: { ...l10, k: Number(e.target.value) },
                  })
                }
              />
            </Field>
            <Field label="최소 당일수익률 (%)">
              <Input
                type="number"
                min={0}
                step={0.1}
                value={Number((l10.minDayReturn * 100).toFixed(3))}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level10_Aggressive: {
                      ...l10,
                      minDayReturn: Number(e.target.value) / 100,
                    },
                  })
                }
              />
            </Field>
            <Field label="매수 비중 (%)">
              <Input
                type="number"
                min={1}
                step={1}
                value={Number((l10.buyPct * 100).toFixed(2))}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    Level10_Aggressive: { ...l10, buyPct: Number(e.target.value) / 100 },
                  })
                }
              />
            </Field>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
