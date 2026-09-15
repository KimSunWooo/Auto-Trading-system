"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BacktestPreview } from "@/components/backtest-preview";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import { PLAYBOOKS, type PlaybookId } from "@/lib/playbooks";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import type { PublicState } from "@/lib/types";

const STEPS = ["증권사", "투자금", "전략", "백테스트", "시작"] as const;

export function OnboardingWizard({
  state,
  onState,
  onClose,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"mock" | "kis">(state.broker.driver === "kis" ? "kis" : "mock");
  const [budget, setBudget] = useState(state.totalDeposit);
  const [selected, setSelected] = useState<PlaybookId[]>(
    state.allocations.filter((row) => row.budget > 0).map((row) => row.strategy as PlaybookId)
      .length
      ? (state.allocations.filter((row) => row.budget > 0).map((row) => row.strategy) as PlaybookId[])
      : ["Level1_Stable", "Level10_Aggressive"],
  );
  const [autoStart, setAutoStart] = useState(true);
  const [saving, setSaving] = useState(false);
  const risk = state.settings.risk ?? DEFAULT_PRODUCT_RISK;

  function toggle(id: PlaybookId) {
    setSelected((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    );
  }

  async function skip() {
    try {
      onState(
        await api<PublicState>("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ onboardingComplete: true }),
        }),
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "건너뛰지 못했습니다.");
    }
  }

  async function finish() {
    if (selected.length < 1) {
      toast.error("전략을 하나 이상 고르세요.");
      return;
    }
    setSaving(true);
    try {
      onState(
        await api<PublicState>("/api/onboarding", {
          method: "POST",
          body: JSON.stringify({
            totalDeposit: budget,
            strategies: selected,
            autoStart,
          }),
        }),
      );
      toast.success(autoStart ? "자동매매를 시작했습니다." : "설정을 저장했습니다. 원할 때 시작하세요.");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "시작하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  function next() {
    if (step === 2 && selected.length < 1) {
      toast.error("전략을 하나 이상 고르세요.");
      return;
    }
    setStep((n) => Math.min(STEPS.length - 1, n + 1));
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">투자 시작 가이드</h2>
          <p className="text-sm text-muted-foreground">
            다섯 단계로 증권사·예산·전략을 고르고 과거 성과를 확인한 뒤 켭니다.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void skip()}>
          나중에 하기
        </Button>
      </div>
      <ol className="grid grid-cols-5 gap-1 text-center text-[11px] sm:text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`rounded-full px-1 py-1 ${
              i === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>증권사 연결</CardTitle>
            <CardDescription>
              앱키는 브라우저에 넣지 않습니다. 한국투자증권은 서버 `.env.local` 에 설정합니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("mock")}
              className={`rounded-xl border p-4 text-left ${mode === "mock" ? "ring-2 ring-primary" : ""}`}
            >
              <div className="font-medium">로컬 모의투자</div>
              <p className="mt-1 text-xs text-muted-foreground">
                지금 바로 연습합니다. 실제 주문은 나가지 않습니다.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMode("kis")}
              className={`rounded-xl border p-4 text-left ${mode === "kis" ? "ring-2 ring-primary" : ""}`}
            >
              <div className="font-medium">한국투자증권</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {state.broker.driver === "kis"
                  ? state.broker.message
                  : "BROKER=kis 와 앱키를 넣은 뒤 서버를 재시작하세요. 현재는 로컬 모의입니다."}
              </p>
            </button>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>투자금 설정</CardTitle>
            <CardDescription>자동매매에 맡길 예산을 정합니다. 로컬 장부 기준입니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-2xl font-semibold tabular-nums">{formatWon(budget)}</div>
            <input
              type="range"
              min={1_000_000}
              max={10_000_000}
              step={500_000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              className="w-full"
            />
            <Label className="grid gap-1 text-xs">
              직접 입력
              <Input
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(Math.max(100_000, Number(e.target.value) || 0))}
              />
            </Label>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>전략 선택</CardTitle>
            <CardDescription>복수 선택이 가능합니다. 안정형+공격형은 70/30으로 나눕니다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {PLAYBOOKS.map((book) => {
              const on = selected.includes(book.id);
              return (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => toggle(book.id)}
                  className={`rounded-xl border p-4 text-left ${on ? "ring-2 ring-primary" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">
                      {book.label}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{book.tone}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{on ? "선택됨" : "꺼짐"}</span>
                  </div>
                  <p className="mt-1 text-sm">{book.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{book.detail}</p>
                </button>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>백테스트 확인</CardTitle>
            <CardDescription>선택한 전략을 과거 일봉에 재생한 결과입니다. 미래 수익을 보장하지 않습니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <BacktestPreview strategies={selected} totalDeposit={budget} years={2} />
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>리스크 한도 확인</CardTitle>
            <CardDescription>한도에 닿으면 당일 자동매매가 멈춥니다. 긴급 정지는 언제든 화면 상단에 있습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="list-disc space-y-1 pl-5">
              <li>일일 최대 손실 {Math.round(risk.dailyLossPct * 100)}%</li>
              <li>종목당 투자 비중 {Math.round(risk.maxTickerWeight * 100)}%</li>
              <li>종목 손절 {Math.round(risk.stopLossPct * 100)}% (평단 대비, 현재가 -3% 지정가 밴드 분할 매도)</li>
            </ul>
            <div className="flex items-center justify-between rounded-xl border px-3 py-2">
              <div>
                <div className="font-medium">자동매매 시작</div>
                <p className="text-xs text-muted-foreground">끄면 시세만 갱신하고 주문은 내지 않습니다.</p>
              </div>
              <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={() => setStep((n) => Math.max(0, n - 1))} disabled={step === 0}>
          이전
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={next}>다음</Button>
        ) : (
          <Button onClick={() => void finish()} disabled={saving}>
            {saving ? "저장 중" : autoStart ? "자동매매 시작" : "설정만 저장"}
          </Button>
        )}
      </div>
    </div>
  );
}
