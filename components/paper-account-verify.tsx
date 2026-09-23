"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PaperAccountVerification } from "@/src/auth/paper-account-verification-types";
import { formatWon } from "@/lib/format";

type VerifyResponse = {
  verification: PaperAccountVerification;
  labels: {
    depositCash: string;
    orderableCash: string;
    strategyCash: string;
  };
};

export function PaperAccountVerifyBanner() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<VerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts/current/verify", { credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        setError(body.error ?? body.code ?? `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setData((await res.json()) as VerifyResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  if (loading) {
    return (
      <div className="border-b bg-muted/50">
        <div className="mx-auto w-full max-w-7xl px-4 py-2 text-sm text-muted-foreground">
          PAPER 계좌 확인 중…
        </div>
      </div>
    );
  }

  if (error || !data?.verification?.bindingVerified) {
    return (
      <div className="border-b border-destructive/40 bg-destructive/10">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
          <div>
            <span className="font-medium">PAPER 계좌 확인 실패</span>
            <span className="text-muted-foreground"> — 신규 주문 차단</span>
            {error ? <span className="ml-2 text-xs text-muted-foreground">{error}</span> : null}
            {data?.verification?.blockers?.length ? (
              <span className="ml-2 text-xs text-muted-foreground">
                {data.verification.blockers.join(", ")}
              </span>
            ) : null}
          </div>
          <button type="button" className="text-xs underline" onClick={() => void run()}>
            다시 확인
          </button>
        </div>
      </div>
    );
  }

  const v = data.verification;
  const ready = v.readyForTrading;

  return (
    <div className={`border-b ${ready ? "bg-emerald-500/10" : "bg-amber-500/10"}`}>
      <div className="mx-auto w-full max-w-7xl space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            {ready ? "KIS PAPER 연결됨" : "KIS PAPER 검증 미완료"}
          </span>
          <Badge variant="outline">계좌 {v.accountMasked}</Badge>
          <Badge variant={ready ? "secondary" : "destructive"}>
            {ready ? "Trading Ready" : "신규 주문 차단"}
          </Badge>
          {!v.paginationComplete ? (
            <Badge variant="destructive">잔고 페이지 미완료</Badge>
          ) : null}
          <button type="button" className="ml-auto text-xs underline" onClick={() => void run()}>
            새로고침
          </button>
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">{data.labels.depositCash}</div>
            <div className="tabular-nums font-medium">{formatWon(v.depositCash)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{data.labels.orderableCash}</div>
            <div className="tabular-nums font-medium">
              {v.orderableCash != null ? formatWon(v.orderableCash) : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{data.labels.strategyCash}</div>
            <div className="tabular-nums font-medium">
              {v.strategyAllocatedCash != null ? formatWon(v.strategyAllocatedCash) : "—"}
            </div>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          보유종목{" "}
          {v.holdings.length === 0
            ? "없음"
            : v.holdings
                .map((h) => `${h.name} ${h.qty}주`)
                .join(" · ")}
          {v.localPositionsMatched ? " · 로컬 수량 일치" : ""}
        </div>
      </div>
    </div>
  );
}

export function RepresentativeDashboardPanel() {
  const [cards, setCards] = useState<
    Array<{
      instrument: { symbol: string; displayName: string; country: string; currency: string };
      price: number | null;
      status: string;
    }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/instruments/dashboard", { credentials: "same-origin" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { cards?: typeof cards };
        if (!cancelled) setCards(body.cards ?? []);
      } catch {
        /* dashboard failure must not surface as trading block */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (cards.length === 0) return null;

  return (
    <Card>
      <CardHeader className="border-b">
        <CardDescription>대표 종목 · 시세 실패 시 stale만 표시 · 주문 회로 영향 없음</CardDescription>
        <CardTitle className="text-base">Market Snapshot</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 pt-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((card) => (
          <div key={`${card.instrument.country}:${card.instrument.symbol}`} className="text-sm">
            <div className="font-medium">{card.instrument.displayName}</div>
            <div className="text-xs text-muted-foreground">{card.instrument.symbol}</div>
            <div className="tabular-nums">
              {card.price == null
                ? "—"
                : card.instrument.currency === "USD"
                  ? `$${card.price.toFixed(2)}`
                  : formatWon(card.price)}
            </div>
            <div className="text-[10px] uppercase text-muted-foreground">{card.status}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
