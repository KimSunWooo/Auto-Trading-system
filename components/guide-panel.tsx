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
    if (
      !window.confirm(
        "로컬 장부를 초기화할까요? 전략 버킷·조건·체결 기록이 지워집니다. 한국투자증권 계좌 잔고는 바뀌지 않습니다.",
      )
    ) {
      return;
    }
    onState(await api<PublicState>("/api/account/reset", { method: "POST" }));
    toast.success("예수금 1,000만원 버킷으로 다시 시작했습니다.");
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>한국투자증권으로 주문하기</CardTitle>
          <CardDescription>
            조건·적립·퀀트·수동 매매는 모두 같은 브로커를 씁니다. 앱키를 넣으면 KIS 모의투자나 실전
            현금 주문이 나갑니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4 text-sm leading-6">
          <p>
            기본값은 로컬 페이퍼 북입니다. 실전 키를 넣기 전에는 주문이 증권사로 전달되지 않습니다.
          </p>
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              <a
                className="underline underline-offset-2"
                href="https://apiportal.koreainvestment.com"
                target="_blank"
                rel="noreferrer"
              >
                한국투자증권 Open API
              </a>
              에서 앱키·앱시크릿을 발급합니다. 모의용과 실전용 키는 다릅니다.
            </li>
            <li>
              `.env.local`에 `BROKER=kis`, `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCOUNT_NO`(예:
              12345678-01)를 넣습니다.
            </li>
            <li>
              모의투자는 `KIS_MODE=demo` 입니다. 실전은 `KIS_MODE=real` 과{" "}
              <code className="rounded bg-muted px-1">KIS_LIVE_CONFIRM=I_UNDERSTAND</code> 가 있어야
              주문이 열립니다.
            </li>
            <li>서버를 재시작한 뒤 상단 배지가 KIS 모의투자 또는 KIS 실전인지 확인합니다.</li>
          </ol>
          <p className="text-muted-foreground">{state.broker?.message}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>장 운영 설정</CardTitle>
          <CardDescription>
            로컬 모의는 주말·야간에도 시세를 움직입니다. KIS 실전은 정규장 외 주문이 거절될 수 있으니
            끄는 것을 권장합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
            <div>
              <Label htmlFor="hours">정규장 외에도 주문</Label>
              <p className="text-xs text-muted-foreground">끄면 09:00–15:30 KST 평일에만 엔진이 돕니다</p>
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
            <div className="mt-2 text-muted-foreground">
              브로커: {state.broker?.driver === "kis" ? "한국투자증권" : "로컬 모의"}
              {state.broker?.accountMasked ? ` · ${state.broker.accountMasked}` : ""}
            </div>
          </div>
          <Button variant="outline" className="w-full" onClick={() => void reset()}>
            로컬 장부 초기화
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
