"use client";

import { toast } from "sonner";
import { GaugeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { Allocation, PublicState } from "@/lib/types";

const PLAYBOOK: Record<number, string> = {
  1: "KODEX 200 정액 적립",
  5: "이평 돌파 스윙",
  10: "변동성 돌파 추격",
};

function playbook(level: number): string {
  if (level <= 3) return PLAYBOOK[1];
  if (level <= 7) return PLAYBOOK[5];
  return PLAYBOOK[10];
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
                    <p className="text-xs text-muted-foreground">{playbook(row.riskLevel)}</p>
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
