"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { formatPct, formatSeoul, formatWon } from "@/lib/format";
import { dashboardStats, ruleCardModel, ruleDisplayName } from "@/lib/dashboard";
import { DisclaimerModal } from "@/components/disclaimer-modal";
import { DEFAULT_PRODUCT_RISK } from "@/src/risk/product";
import type { PublicState, Quote } from "@/lib/types";

function holdingRows(state: PublicState) {
  const rows = new Map<string, { name: string; kisQty: number; localQty: number }>();
  for (const pos of state.positions) {
    if (pos.qty < 1) continue;
    const cur = rows.get(pos.code) ?? { name: pos.name, kisQty: 0, localQty: 0 };
    cur.localQty += pos.qty;
    cur.name = pos.name || cur.name;
    rows.set(pos.code, cur);
  }
  for (const hold of state.kisBalance?.holdings ?? []) {
    const cur = rows.get(hold.ticker) ?? { name: hold.name, kisQty: 0, localQty: 0 };
    cur.kisQty += hold.qty;
    cur.name = hold.name || cur.name;
    rows.set(hold.ticker, cur);
  }
  return [...rows.entries()];
}

export function OverviewPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  const stats = dashboardStats(state);
  const pnl = stats.pnl;
  const quotes = useMemo(
    () =>
      Object.values(state.quotes).sort(
        (a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name, "ko"),
      ),
    [state.quotes],
  );
  const kisHoldingRows = state.kisBalance ? holdingRows(state) : [];
  const risk = state.settings.risk ?? DEFAULT_PRODUCT_RISK;
  const rules = state.ruleConfig?.rules ?? [];
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  async function setAutoTrading(autoTrading: boolean) {
    if (autoTrading && !state.settings.disclaimerAccepted) {
      setDisclaimerOpen(true);
      return;
    }
    try {
      onState(
        await api<PublicState>("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ autoTrading }),
        }),
      );
      toast.success(autoTrading ? "자동 실행을 켰습니다." : "자동 실행을 멈췄습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "자동 실행을 바꾸지 못했습니다.");
    }
  }

  async function acceptAndStart() {
    onState(
      await api<PublicState>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ disclaimerAccepted: true, autoTrading: true }),
      }),
    );
    toast.success("이용에 동의하고 자동 실행을 켰습니다.");
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="총 자산" value={formatWon(stats.equity)} hint="현금 + 보유주식 평가" />
        <Stat
          label="평가손익"
          value={`${pnl >= 0 ? "+" : ""}${formatWon(pnl)}`}
          hint={`시작 대비 ${formatPct(stats.pnlPct)}`}
          tone={pnl}
        />
        <Stat label="당일 매매" value={`${stats.tradesToday}건`} hint="오늘 체결된 주문" />
        <Stat
          label="당일 승률"
          value={stats.winRatePct == null ? "—" : `${stats.winRatePct.toFixed(0)}%`}
          hint={stats.winRatePct == null ? "청산된 매도가 없습니다" : "당일 매도 기준"}
        />
      </div>

      {(state.equityHistory?.length ?? 0) > 2 ? (
        <Card size="sm">
          <CardHeader>
            <CardDescription>최근 평가금액</CardDescription>
            <Sparkline values={state.equityHistory} width={720} height={56} className="w-full" />
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        {rules.length === 0 ? (
          <Card className="md:col-span-3" size="sm">
            <CardHeader>
              <CardDescription>사용자 설정</CardDescription>
              <CardTitle className="text-base">조건식이 없습니다</CardTitle>
              <p className="text-sm text-muted-foreground">
                매매 룰 탭에서 종목코드·매수/매도 조건·1회 금액·손절/익절을 직접 입력하세요. 회사가
                미리 정해 둔 종목이나 템플릿은 없습니다.
              </p>
            </CardHeader>
          </Card>
        ) : (
          rules.map((rule) => {
            const card = ruleCardModel(state, rule);
            return (
              <Card key={rule.id} size="sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardDescription>
                        {card.ticker} · {card.kindLabel}
                        {card.enabled ? "" : " · 중지"}
                      </CardDescription>
                      <CardTitle className="text-base">{card.name}</CardTitle>
                    </div>
                    <Badge variant={card.enabled && state.settings.autoTrading ? "default" : "secondary"}>
                      {card.enabled && state.settings.autoTrading ? "가동" : "대기"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-1 text-sm">
                    <div>
                      <div className="text-[11px] text-muted-foreground">배정 예수금</div>
                      <div className="tabular-nums">{formatWon(card.budget)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground">평가 대비</div>
                      <div className={`tabular-nums ${card.returnPct >= 0 ? "text-up" : "text-down"}`}>
                        {formatPct(card.returnPct)}
                      </div>
                    </div>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {card.lastMessage ?? "사용자가 입력한 조건식"}
                  </p>
                </CardHeader>
              </Card>
            );
          })
        )}
      </div>

      {state.kisBalance ? (
        <Card>
          <CardHeader className="border-b">
            <CardDescription>KIS inquire-balance · 30초마다</CardDescription>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              증권사 실잔고
              <Badge variant={state.kisBalance.matched ? "secondary" : "destructive"}>
                {state.kisBalance.matched ? "일치" : "불일치"}
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {state.kisBalance.syncedAt ? formatSeoul(state.kisBalance.syncedAt) : ""} ·{" "}
              {state.kisBalance.message}
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-xs text-muted-foreground">로컬 버킷 합계</div>
                <div className="tabular-nums font-medium">{formatWon(state.cash)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">KIS 예수금</div>
                <div className="tabular-nums font-medium">{formatWon(state.kisBalance.cash)}</div>
              </div>
            </div>
            {kisHoldingRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">보유 종목이 없습니다.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>종목</TableHead>
                    <TableHead>KIS 수량</TableHead>
                    <TableHead>로컬 수량</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kisHoldingRows.map(([ticker, row]) => (
                    <TableRow key={ticker}>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-muted-foreground">{ticker}</div>
                      </TableCell>
                      <TableCell className="tabular-nums">{row.kisQty}</TableCell>
                      <TableCell className="tabular-nums">{row.localQty}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-primary/30">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>자동매매 시작</CardTitle>
            <CardDescription>
              사용자가 저장한 조건식만 기계적으로 실행합니다. 일일 손실{" "}
              {Math.round(risk.dailyLossPct * 100)}% · 종목 비중 {Math.round(risk.maxTickerWeight * 100)}%.
              긴급 정지는 상단 버튼을 쓰세요.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">
              {state.settings.autoTrading ? "가동 중" : "정지"}
            </span>
            <Switch
              checked={state.settings.autoTrading}
              onCheckedChange={(checked) => void setAutoTrading(Boolean(checked))}
            />
          </div>
        </CardHeader>
      </Card>
      <DisclaimerModal
        open={disclaimerOpen}
        onOpenChange={setDisclaimerOpen}
        confirmLabel="동의하고 자동매매 시작"
        onAccept={acceptAndStart}
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
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
    <Card className="min-w-0">
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
                  {quotes.length === 0
                    ? "관심종목이 없습니다. 매매 룰에 종목코드를 입력하면 호가가 나타납니다."
                    : "검색 결과가 없습니다."}
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
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <CardTitle>잔고</CardTitle>
        <CardDescription>평균단가 대비 평가손익입니다.</CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {state.positions.length === 0 ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            보유 종목이 없습니다. 조건식을 저장하거나 조건·적립 매수를 직접 등록하세요.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>종목</TableHead>
                <TableHead className="text-right">수량</TableHead>
                <TableHead className="text-right">평가</TableHead>
                <TableHead className="w-[1%] text-right">
                  <span className="sr-only">매도</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.positions.map((p) => {
                const quote = state.quotes[p.code];
                const last = quote?.price ?? p.avgPrice;
                const evalAmt = p.qty * last;
                const pnl = (last - p.avgPrice) * p.qty;
                const ruleName = ruleDisplayName(state.ruleConfig?.rules ?? [], p.ruleId);
                return (
                  <TableRow key={`${p.ruleId}-${p.code}`}>
                    <TableCell className="max-w-[16rem] whitespace-normal">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{ruleName}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.code} · 평단 {formatWon(p.avgPrice)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.qty}주</TableCell>
                    <TableCell className="text-right">
                      <div className="tabular-nums">{formatWon(evalAmt)}</div>
                      <div className={pnl >= 0 ? "text-xs text-up" : "text-xs text-down"}>
                        {pnl >= 0 ? "+" : ""}
                        {formatWon(pnl)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!quote}
                        onClick={() =>
                          quote
                            ? void buySell(quote, "sell", onState, p.qty, p.ruleId)
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
  ruleId = "cash",
) {
  try {
    const next = await api<PublicState>("/api/orders", {
      method: "POST",
      body: JSON.stringify({ code: quote.code, side, qty, ruleId }),
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
  if (state.market.open) {
    return <Badge variant="default">{state.market.sessionLabel}</Badge>;
  }
  if (state.settings.ignoreMarketHours) {
    return <Badge variant="outline">시세상시 · 주문대기</Badge>;
  }
  return (
    <Badge variant="outline">
      {state.market.sessionLabel} · 주문대기
    </Badge>
  );
}
