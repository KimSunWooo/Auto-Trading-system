"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import { DISCLAIMER_TEXT } from "@/src/rules/params";
import type { PublicState } from "@/lib/types";
import { DisclaimerModal } from "@/components/disclaimer-modal";
import { RuleBuilder, draftToRule, emptyDraft, type RuleDraft } from "@/components/rule-builder";

const STEPS = ["증권사", "예수금", "매매 룰", "면책", "시작"] as const;

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
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [autoStart, setAutoStart] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const risk = state.settings.risk ?? DEFAULT_PRODUCT_RISK;

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

  async function submit(opts: { autoStart: boolean; disclaimerAccepted: boolean }) {
    setSaving(true);
    try {
      const rule = draft.ticker.length === 6 ? draftToRule(draft) : undefined;
      if (rule && rule.budget <= 0) rule.budget = budget;
      onState(
        await api<PublicState>("/api/onboarding", {
          method: "POST",
          body: JSON.stringify({
            totalDeposit: budget,
            rule,
            autoStart: opts.autoStart,
            disclaimerAccepted: opts.disclaimerAccepted,
          }),
        }),
      );
      toast.success(opts.autoStart ? "설정한 조건으로 실행을 시작했습니다." : "사용자 설정을 저장했습니다.");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  function next() {
    if (step === 2 && draft.ticker && draft.ticker.length !== 6) {
      toast.error("종목코드는 6자리입니다. 비워 두면 조건식 없이 저장할 수 있습니다.");
      return;
    }
    setStep((n) => Math.min(STEPS.length - 1, n + 1));
  }

  function finish() {
    if (autoStart) {
      setDisclaimerOpen(true);
      return;
    }
    void submit({ autoStart: false, disclaimerAccepted: disclaimerChecked });
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">시작 가이드</h2>
          <p className="text-sm text-muted-foreground">
            종목·조건·금액을 직접 입력하는 매매 실행 도구입니다. 미리 정해 둔 조건식이나 종목은 없습니다.
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
            <CardTitle>예수금 설정</CardTitle>
            <CardDescription>이 도구가 사용할 로컬 장부 예수금입니다. 증권사가 대신 판단하지 않습니다.</CardDescription>
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
            <CardTitle>매매 룰 직접 입력</CardTitle>
            <CardDescription>
              거래할 종목코드, 매수/매도 조건, 1회 매수 금액, 손절/익절 라인을 빈칸에 넣습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RuleBuilder value={draft} onChange={setDraft} />
          </CardContent>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>이용 동의</CardTitle>
            <CardDescription>자동 실행을 켜려면 아래 내용에 명시적으로 동의해야 합니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6">{DISCLAIMER_TEXT}</p>
            <label className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={disclaimerChecked}
                onChange={(event) => setDisclaimerChecked(event.target.checked)}
              />
              <span>위 내용을 읽었고, 모든 투자 판단과 결과에 대한 책임이 본인에게 있음에 동의합니다.</span>
            </label>
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>실행 한도 확인</CardTitle>
            <CardDescription>
              소프트웨어 안전장치입니다. 한도에 닿으면 당일 자동 실행이 멈춥니다. 긴급 정지는 화면 상단에 있습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="list-disc space-y-1 pl-5">
              <li>일일 최대 손실 {Math.round(risk.dailyLossPct * 100)}%</li>
              <li>종목당 투자 비중 {Math.round(risk.maxTickerWeight * 100)}%</li>
              <li>조건식 손절/익절은 사용자가 입력한 비율을 따릅니다.</li>
            </ul>
            <div className="flex items-center justify-between rounded-xl border px-3 py-2">
              <div>
                <div className="font-medium">자동매매 시작</div>
                <p className="text-xs text-muted-foreground">
                  켜면 면책 동의 후에만 API 주문이 나갑니다. 끄면 설정만 저장합니다.
                </p>
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
          <Button onClick={next} disabled={step === 3 && !disclaimerChecked}>
            다음
          </Button>
        ) : (
          <Button onClick={() => void finish()} disabled={saving}>
            {saving ? "저장 중" : autoStart ? "자동매매 시작" : "설정만 저장"}
          </Button>
        )}
      </div>

      <DisclaimerModal
        open={disclaimerOpen}
        onOpenChange={setDisclaimerOpen}
        confirmLabel="동의하고 자동매매 시작"
        onAccept={() => submit({ autoStart: true, disclaimerAccepted: true })}
      />
    </div>
  );
}
