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
        "로컬 장부를 초기화할까요? 사용자 설정·조건·체결 기록이 지워집니다. 한국투자증권 계좌 잔고는 바뀌지 않습니다.",
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
            조건·적립·매매 룰·수동 주문은 모두 같은 브로커를 씁니다. 앱키를 넣으면 KIS 모의투자나 실전
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
              `.env.local`에 `BROKER=kis`, 모의투자라면 `KIS_PAPER_APP_KEY` /
              `KIS_PAPER_APP_SECRET` / `KIS_PAPER_ACCOUNT_NO`(예: 12345678-01)를 넣습니다. 실전은
              `KIS_REAL_*` 만 사용하며 모의 키와 섞이지 않습니다.
            </li>
            <li>
              모의투자는 `KIS_MODE=paper`(또는 `demo`) 입니다. 실전은 `KIS_MODE=real` 과{" "}
              <code className="rounded bg-muted px-1">KIS_LIVE_CONFIRM=I_UNDERSTAND</code> 가 있어야
              주문이 열립니다.
            </li>
            <li>서버를 재시작한 뒤 상단 배지가 KIS 모의투자 또는 KIS 실전인지 확인합니다.</li>
          </ol>
          <p className="text-muted-foreground">{state.broker?.message}</p>
          <p>
            주문번호(ODNO)는 접수로만 취급합니다. 장부에는 체결내역의 실제 체결 수량만 반영하고,
            미체결 잔량은 30초 뒤 취소합니다. 타임아웃이 나면 미체결로 단정하지 않고 주문을 미확인으로
            남긴 뒤 서킷을 엽니다. 로컬 0.015% 수수료는 참고용이며, 30초마다 KIS 잔고조회와 버킷·보유수량을
            비교해 어긋나면 주문을 중지합니다. 종목·실행 주기·이평·손절/익절은{" "}
            <code className="rounded bg-muted px-1">data/strategy-config.json</code> 과 매매 룰 탭에서
            사용자가 직접 넣습니다. 일일 손실 3%·종목 비중 20%는 소프트웨어 한도입니다. 손절과 긴급 정지는
            시장가 대신 현재가 ±3% 지정가 밴드로 분할 매도합니다. 에코프로비엠(247540) 같은 고변동 종목은
            시장가 주문을 받지 않고 같은 밴드로 전환합니다. 상단{" "}
            <strong>긴급 정지</strong>는 미체결을 즉시 취소하고 보유를 지정가 밴드 청산한 뒤 KIS 실잔고로 장부를
            맞춥니다. 본 도구는 종목 추천이나 투자 일임을 하지 않습니다. 상단 빨간 띠가 보이면 신규 주문은
            나가지 않습니다.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>장 운영 설정</CardTitle>
          <CardDescription>
            로컬 모의는 주말·야간에도 시세를 움직일 수 있습니다. 주문은 브로커와 관계없이 정규장(09:00~15:20 KST)만
            허용합니다. 동시호가·주말·공휴일에는 조건이 맞아도 거부하고 로그만 남깁니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
            <div>
              <Label htmlFor="hours">정규장 외에도 시세</Label>
              <p className="text-xs text-muted-foreground">
                로컬 모의 호가만 상시 갱신합니다. 신규 주문은 항상 09:00~15:20 정규장에서만 나갑니다.
              </p>
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
