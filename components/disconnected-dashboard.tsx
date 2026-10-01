"use client";

import { useState } from "react";
import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AccountConnectionIssue } from "@/src/runtime/account-connection-types";

const ISSUE_COPY: Record<
  AccountConnectionIssue["code"],
  { title: string; detail: string }
> = {
  ACCOUNT_NOT_CONNECTED: {
    title: "PAPER 계좌가 연결되어 있지 않습니다",
    detail:
      "마이페이지에서 KIS PAPER 계좌를 연결하면 예수금·보유·미체결이 대시보드에 표시됩니다. 가짜 잔고는 표시하지 않습니다.",
  },
  ACCOUNT_SELECTION_REQUIRED: {
    title: "기본 PAPER 계좌를 선택해야 합니다",
    detail:
      "ACTIVE PAPER 계좌가 여러 개입니다. 임의로 선택하지 않으며, 마이페이지에서 기본 계좌를 지정하세요.",
  },
  MULTIPLE_DEFAULT_ACCOUNTS: {
    title: "기본 PAPER 계좌가 중복되어 있습니다",
    detail:
      "기본 계좌가 둘 이상입니다. 모호한 선택은 차단됩니다. 마이페이지에서 기본 계좌를 하나만 남기세요.",
  },
  ACCOUNT_FINGERPRINT_MISSING: {
    title: "계좌 물리 지문이 없습니다",
    detail:
      "ACTIVE PAPER 계좌의 physical fingerprint가 없습니다. 자격증명을 다시 등록하거나 운영 복구 절차를 사용하세요.",
  },
  CREDENTIAL_MISSING: {
    title: "PAPER 자격증명을 찾을 수 없습니다",
    detail:
      "계좌 행은 있으나 암호화된 자격증명이 없습니다. 마이페이지에서 PAPER 키를 다시 등록하세요.",
  },
  CREDENTIAL_DECRYPT_FAILED: {
    title: "자격증명 복호화에 실패했습니다",
    detail:
      "마스터키 불일치 또는 손상된 암호문일 수 있습니다. 정상 연결로 표시하지 않으며, 운영자 재바인딩이 필요할 수 있습니다.",
  },
  RUNTIME_RESOLUTION_FAILED: {
    title: "런타임 준비에 실패했습니다",
    detail:
      "인증은 성공했지만 계좌 런타임을 만들지 못했습니다. 신규 주문은 차단되며, 마이페이지에서 연결 상태를 확인하세요.",
  },
};

export function DisconnectedDashboard({
  currentUser,
  issue,
}: {
  currentUser: { displayName: string; role: string };
  issue: AccountConnectionIssue;
}) {
  const [menu, setMenu] = useState(false);
  const copy = ISSUE_COPY[issue.code] ?? ISSUE_COPY.RUNTIME_RESOLUTION_FAILED;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    try {
      sessionStorage.clear();
      localStorage.removeItem("trading-state-cache");
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  }

  function goMypage() {
    window.location.href = "/mypage";
  }

  const userBlock = (
    <div className="hidden items-center gap-2 sm:flex">
      <div className="text-right leading-tight">
        <div className="text-sm font-medium">{currentUser.displayName}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {currentUser.role}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={goMypage}>
        마이페이지
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void logout()}>
        로그아웃
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMenu(true)}
            aria-label="메뉴"
          >
            <MenuIcon />
          </Button>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              M
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
                미리매수
              </h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                사용자 조건식 기반 API 매매 실행 도구
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">{userBlock}</div>
        </div>
      </header>

      <div className="border-b border-amber-500/40 bg-amber-500/10">
        <div className="mx-auto w-full max-w-7xl px-4 py-2 text-sm">
          계좌 미연결 · 예수금·보유·주문을 표시하지 않습니다
        </div>
      </div>

      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader>
            <SheetTitle>미리매수</SheetTitle>
          </SheetHeader>
          <nav className="grid gap-1 px-3 pb-6">
            <div className="mb-2 rounded-md border border-border px-3 py-2 text-sm">
              <div className="font-medium">{currentUser.displayName}</div>
              <div className="text-xs uppercase text-muted-foreground">{currentUser.role}</div>
            </div>
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                goMypage();
              }}
            >
              마이페이지
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                void logout();
              }}
            >
              로그아웃
            </Button>
          </nav>
        </SheetContent>
      </Sheet>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-10">
        <section className="max-w-xl space-y-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{issue.code}</p>
          <h2 className="text-2xl font-semibold tracking-tight">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.detail}</p>
          {issue.message ? (
            <p className="text-xs text-muted-foreground">상세: {issue.message}</p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={goMypage}>계좌 설정으로 이동</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              다시 확인
            </Button>
          </div>
        </section>

        <section className="grid max-w-xl gap-3 text-sm text-muted-foreground">
          <div>
            <div className="text-xs">KIS 예수금</div>
            <div className="font-medium text-foreground">—</div>
          </div>
          <div>
            <div className="text-xs">KIS 주문가능금액</div>
            <div className="font-medium text-foreground">—</div>
          </div>
          <div>
            <div className="text-xs">전략 배정 잔액</div>
            <div className="font-medium text-foreground">—</div>
          </div>
          <div>
            <div className="text-xs">보유 종목</div>
            <div className="font-medium text-foreground">계좌 연결 후 표시</div>
          </div>
        </section>
      </main>
    </div>
  );
}
