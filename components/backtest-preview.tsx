"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkline } from "@/components/price";
import { api } from "@/hooks/use-trading";
import { formatPct, formatWon } from "@/lib/format";

export type BacktestResultView = {
  years: number;
  ruleIds: string[];
  metrics: {
    startEquity: number;
    endEquity: number;
    totalReturnPct: number;
    mddPct: number;
    trades: number;
    winRatePct: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    wins: number;
    losses: number;
  };
  equityCurve: Array<{ t: number; equity: number }>;
  tradeLog: Array<{
    at: string;
    side: "buy" | "sell";
    name: string;
    qty: number;
    price: number;
    realizedPnl?: number;
  }>;
};

export function BacktestPreview({
  totalDeposit,
  years = 2,
}: {
  totalDeposit: number;
  years?: number;
}) {
  const [data, setData] = useState<BacktestResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = useMemo(() => `${totalDeposit}:${years}`, [totalDeposit, years]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<BacktestResultView>("/api/backtest", {
      method: "POST",
      body: JSON.stringify({ totalDeposit, years }),
    })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "조건 재생에 실패했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, totalDeposit, years]);

  if (loading) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        저장한 조건식을 과거 {years}년 일봉에 기계적으로 재생하는 중입니다.
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-sm">
        {error}
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={() => toast.message("조건식을 저장한 뒤 다시 시도하세요.")}>
            확인
          </Button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const m = data.metrics;
  const curve = data.equityCurve.map((row) => row.equity);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        사용자 조건식 {data.ruleIds.length}개 · 예산 {formatWon(totalDeposit)} · 일봉 {data.years}년
        (로컬 시뮬레이터, 실전 수익이 아닙니다)
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="총 수익률" value={formatPct(m.totalReturnPct)} tone={m.totalReturnPct} />
        <Metric label="MDD" value={`${m.mddPct.toFixed(2)}%`} />
        <Metric
          label="승률"
          value={m.winRatePct == null ? "청산 전" : `${m.winRatePct.toFixed(1)}%`}
        />
        <Metric label="총 거래" value={`${m.trades}건`} />
        <Metric
          label="평균 손익"
          value={
            m.avgWin == null && m.avgLoss == null
              ? "—"
              : `${m.avgWin != null ? "+" + formatWon(m.avgWin) : "—"} / ${m.avgLoss != null ? formatWon(m.avgLoss) : "—"}`
          }
        />
      </div>
      <div className="overflow-x-auto rounded-xl border px-3 py-3">
        <Sparkline values={curve} width={640} height={88} className="w-full max-w-full" />
      </div>
      {data.tradeLog.length === 0 ? (
        <p className="text-xs text-muted-foreground">이 기간에 기록된 체결이 없습니다. 조건식이 없으면 재생하지 않습니다.</p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-auto text-xs text-muted-foreground">
          {data.tradeLog.slice(0, 12).map((row, i) => (
            <li key={`${row.at}-${i}`}>
              {row.side === "buy" ? "매수" : "매도"} {row.name} {row.qty}주 · {formatWon(row.price)}
              {row.realizedPnl != null
                ? ` · ${row.realizedPnl >= 0 ? "+" : ""}${formatWon(row.realizedPnl)}`
                : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-base tabular-nums ${
            tone == null ? "" : tone > 0 ? "text-up" : tone < 0 ? "text-down" : ""
          }`}
        >
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
