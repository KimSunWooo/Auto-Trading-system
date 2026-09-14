"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { api } from "@/hooks/use-trading";
import type { PublicState } from "@/lib/types";

export function GuidePanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  async function reset() {
    if (!window.confirm("모의계좌를 초기화할까요? 잔고·조건·체결이 모두 지워집니다.")) return;
    onState(await api<PublicState>("/api/account/reset", { method: "POST" }));
    toast.success("예수금 1,000만원으로 다시 시작했습니다.");
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>왜 모의투자인가</CardTitle>
          <CardDescription>
            미래에셋증권은 개인 투자자용 매매 Open API를 제공하지 않습니다. 모바일 앱을 우회하거나
            화면을 조작하는 방식은 약관 위반이자 계좌 보안에 위험이 됩니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4 text-sm leading-6">
          <p>
            이 프로그램은 카이로스 <strong>0635 주식 서버자동주문</strong>과 같은 조건매수 엔진을
            로컬 모의계좌에서 돌립니다. 전략을 검증한 뒤, 같은 조건을 실제 HTS에 옮기면 됩니다.
          </p>
          <ol className="list-decimal space-y-2 pl-4">
            <li>m.Stock 또는 카이로스에서 국내주식 자동주문시스템을 신청합니다.</li>
            <li>
              주식특화주문 → 서버자동주문신청/해지에서 사용 계좌를 등록합니다.
            </li>
            <li>
              카이로스 0635에서 감시기준(현재가/매수1/매도1), 조건가격, 수량, 주문호가를 이 화면과
              동일하게 저장하고 감시를 켭니다.
            </li>
            <li>정규장은 09:00–15:30(KST)만 감시됩니다. PC를 꺼도 서버가 주문을 냅니다.</li>
          </ol>
          <p className="text-muted-foreground">
            퀀트 탭의 전략은 <strong>IBroker</strong>만 호출합니다. 기본값은 MockBroker(모의체결)이고,
            한국투자증권 실연동은 KisBroker 골격에 Open API를 채운 뒤{" "}
            <code className="rounded bg-muted px-1">BROKER=kis</code> 로 교체합니다.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>모의장 설정</CardTitle>
          <CardDescription>
            기본값은 주말·야간에도 시세가 움직이도록 상시개장입니다. 끄면 실제 KRX 정규장에만
            주문이 나갑니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
            <div>
              <Label htmlFor="hours">정규장 외 모의매매</Label>
              <p className="text-xs text-muted-foreground">끄면 09:00–15:30 KST 평일에만 체결</p>
            </div>
            <Switch
              id="hours"
              checked={state.settings.ignoreMarketHours}
              onCheckedChange={(checked) =>
                void api<PublicState>("/api/settings", {
                  method: "PATCH",
                  body: JSON.stringify({ ignoreMarketHours: Boolean(checked) }),
                }).then(onState)
              }
            />
          </div>
          <div className="rounded-lg bg-muted px-3 py-3 text-sm">
            <div>현재 세션: {state.market.sessionLabel}</div>
            <div className="text-muted-foreground">
              실제 개장 여부: {state.market.open ? "개장" : "휴장/장마감"} · 타임존 Asia/Seoul
            </div>
          </div>
          <Button variant="outline" className="w-full" onClick={() => void reset()}>
            모의계좌 초기화
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
