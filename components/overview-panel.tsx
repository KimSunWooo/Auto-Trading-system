"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Change, Price, Sparkline } from "@/components/price";
import { api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { PublicState, Quote } from "@/lib/types";

export function OverviewPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  const quotes = useMemo(
    () => Object.values(state.quotes).sort((a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name, "ko")),
    [state.quotes],
  );

  const pnl = state.equity - state.settings.startingCash;
  const holdings = state.positions.reduce((sum, p) => {
    const q = state.quotes[p.code];
    return sum + p.qty * (q?.price ?? p.avgPrice);
  }, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="평가금액" value={formatWon(state.equity)} hint="현금 + 보유주식" />
        <Stat label="예수금" value={formatWon(state.cash)} hint="버킷 가용 합계" />
        <Stat label="보유주식" value={formatWon(holdings)} hint={`${state.positions.length}종목`} />
        <Stat
          label="누적손익"
          value={`${pnl >= 0 ? "+" : ""}${formatWon(pnl)}`}
          hint="시작 1,000만원 대비"
          tone={pnl}
        />
      </div>

      {state.allocations.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {state.allocations.map((row) => (
            <Card key={row.strategy} size="sm">
              <CardHeader>
                <CardDescription>
                  {row.strategy} · 리스크 {row.riskLevel}
                  {row.enabled ? "" : " · 중지"}
                </CardDescription>
                <CardTitle className="text-base tabular-nums">
                  {formatWon(row.balance)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    / {formatWon(row.budget)}
                  </span>
                </CardTitle>
                <p className="truncate text-xs text-muted-foreground">
                  {row.lastMessage ?? "퀀트 탭에서 전략을 켜 두세요."}
                </p>
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Watchlist
          quotes={quotes}
          onState={onState}
          liveQuotes={state.broker?.driver === "kis"}
        />
        <Positions state={state} onState={onState} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: number;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={`text-xl tabular-nums ${
            tone == null ? "" : tone > 0 ? "text-up" : tone < 0 ? "text-down" : ""
          }`}
        >
          {value}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
    </Card>
  );
}

function Watchlist({
  quotes,
  onState,
  liveQuotes,
}: {
  quotes: Quote[];
  onState: (next: PublicState) => void;
  liveQuotes: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = quotes.filter(
    (q) => q.name.includes(query) || q.code.includes(query) || q.market.includes(query.toUpperCase()),
  );

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>관심종목</CardTitle>
            <CardDescription>
              {liveQuotes
                ? "한국투자증권 현재가를 주기적으로 가져옵니다. 상승은 빨강입니다."
                : "2.5초마다 호가가 움직입니다. 국내 관례로 상승은 빨강입니다."}
            </CardDescription>
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="종목명 또는 코드"
            className="sm:w-48"
          />
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>종목</TableHead>
              <TableHead>현재가</TableHead>
              <TableHead>등락</TableHead>
              <TableHead className="hidden md:table-cell">추이</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  검색 결과가 없습니다.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((quote) => (
                <TableRow key={quote.code}>
                  <TableCell>
                    <div className="font-medium">{quote.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {quote.market} · {quote.code}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Price value={quote.price} prevClose={quote.prevClose} />
                  </TableCell>
                  <TableCell>
                    <Change price={quote.price} prevClose={quote.prevClose} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Sparkline values={quote.history} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        className="text-up"
                        onClick={() => void buySell(quote, "buy", onState)}
                      >
                        매수
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className="text-down"
                        onClick={() => void buySell(quote, "sell", onState)}
                      >
                        매도
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Positions({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>잔고</CardTitle>
        <CardDescription>평균단가 대비 평가손익입니다.</CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {state.positions.length === 0 ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            보유 종목이 없습니다. 관심종목에서 매수하거나 조건·적립을 켜 보세요.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>종목</TableHead>
                <TableHead>수량</TableHead>
                <TableHead>평가</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.positions.map((p) => {
                const quote = state.quotes[p.code];
                const last = quote?.price ?? p.avgPrice;
                const evalAmt = p.qty * last;
                const pnl = (last - p.avgPrice) * p.qty;
                return (
                  <TableRow key={`${p.strategy}-${p.code}`}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.strategy} · 평단 {formatWon(p.avgPrice)}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{p.qty}주</TableCell>
                    <TableCell>
                      <div className="tabular-nums">{formatWon(evalAmt)}</div>
                      <div className={pnl >= 0 ? "text-xs text-up" : "text-xs text-down"}>
                        {pnl >= 0 ? "+" : ""}
                        {formatWon(pnl)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          quote
                            ? void buySell(quote, "sell", onState, p.qty, p.strategy)
                            : undefined
                        }
                      >
                        전량매도
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

async function buySell(
  quote: Quote,
  side: "buy" | "sell",
  onState: (next: PublicState) => void,
  qty = 1,
  strategy = "Level1_Stable",
) {
  try {
    const next = await api<PublicState>("/api/orders", {
      method: "POST",
      body: JSON.stringify({ code: quote.code, side, qty, strategy }),
    });
    onState(next);
    toast.success(`${quote.name} ${qty}주 ${side === "buy" ? "매수" : "매도"} 체결`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "주문에 실패했습니다.");
  }
}

export function BrokerBadge({ state }: { state: PublicState }) {
  if (state.broker?.driver !== "kis") {
    return <Badge variant="secondary">로컬 모의</Badge>;
  }
  if (state.broker.mode === "real" && state.broker.liveEnabled) {
    return <Badge variant="destructive">KIS 실전</Badge>;
  }
  if (state.broker.mode === "real") {
    return <Badge variant="outline">KIS 실전 · 주문잠금</Badge>;
  }
  return <Badge variant="secondary">KIS 모의투자</Badge>;
}

export function MarketBadge({ state }: { state: PublicState }) {
  const live = state.settings.ignoreMarketHours || state.market.open;
  return (
    <Badge variant={live ? "default" : "outline"}>
      {state.settings.ignoreMarketHours
        ? "상시개장"
        : `${state.market.sessionLabel}${state.market.open ? "" : " · 주문대기"}`}
    </Badge>
  );
}
