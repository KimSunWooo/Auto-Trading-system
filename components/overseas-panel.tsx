"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/hooks/use-trading";
import { formatPct, formatUsd, formatWon } from "@/lib/format";
import type { OverseasAccountSnapshot, OverseasQuote } from "@/src/markets/overseas/types";
import type { OverseasInstrument } from "@/src/markets/overseas/instruments";
import type { CurrencyExchangeAudit } from "@/src/markets/overseas/types";

type SearchItem = { instrument: OverseasInstrument; quote: OverseasQuote | null };

type SearchResponse = {
  items: SearchItem[] | OverseasInstrument[];
  source?: string;
  message?: string;
  error?: string;
  exchangeAudit?: CurrencyExchangeAudit;
  ordersEnabled?: boolean;
};

type AccountResponse = {
  account: OverseasAccountSnapshot | null;
  openOrders?: Array<{ orderNo: string; identity: string; remainingQty: number; qty: number; filledQty: number }>;
  executions?: Array<{ orderNo: string; identity: string; filledQty: number }>;
  ordersEnabled?: boolean;
  exchangeAudit?: CurrencyExchangeAudit;
  error?: string;
  message?: string;
};

function isSearchItem(row: SearchItem | OverseasInstrument): row is SearchItem {
  return "instrument" in row;
}

function marketLabel(status: OverseasQuote["marketStatus"]) {
  if (status === "open") return "정규장";
  if (status === "closed") return "휴장";
  return "확인불가";
}

export function OverseasPanel() {
  const [query, setQuery] = useState("AAPL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [account, setAccount] = useState<OverseasAccountSnapshot | null>(null);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [audit, setAudit] = useState<CurrencyExchangeAudit | null>(null);

  const loadAccount = useCallback(async (symbol = "NASDAQ:AAPL") => {
    try {
      const data = await api<AccountResponse>(`/api/overseas/account?symbol=${encodeURIComponent(symbol)}`);
      if (data.account) setAccount(data.account);
      if (data.exchangeAudit) setAudit(data.exchangeAudit);
      if (data.error && !data.account) setError(data.error);
    } catch (err) {
      setError((current) => current ?? (err instanceof Error ? err.message : "외화 잔고를 불러오지 못했습니다."));
    }
  }, []);

  const loadSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const data = await api<SearchResponse>(`/api/overseas/search?q=${encodeURIComponent(q)}`);
      if (data.exchangeAudit) setAudit(data.exchangeAudit);
      const next: SearchItem[] = (data.items ?? []).map((row) =>
        isSearchItem(row) ? row : { instrument: row, quote: null },
      );
      setItems(next);
      setSelected(next[0] ?? null);
      setError(data.error ?? data.message ?? null);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "해외주식 검색에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSearch("");
    void loadAccount();
  }, [loadAccount, loadSearch]);

  const usd = account?.cash.find((row) => row.currency === "USD");
  const quote = selected?.quote ?? null;
  const instrument = selected?.instrument;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="외화잔고 (USD)" value={usd ? formatUsd(usd.cash) : "—"} hint="KIS present-balance · 원화와 합치지 않음" />
        <Stat
          label="매수가능금액"
          value={
            account?.buyingPower != null
              ? formatUsd(account.buyingPower.orderableCash)
              : usd
                ? formatUsd(usd.orderableCash)
                : "—"
          }
          hint="inquire-psamount / 외화 주문가능"
        />
        <Stat
          label="적용 환율"
          value={account?.fx ? `USD/KRW ${account.fx.rate.toLocaleString("ko-KR")}` : "—"}
          hint={account?.fx ? `${account.fx.source} · ${account.fx.baseCurrency}/${account.fx.quoteCurrency}` : "환율이 없으면 환산하지 않습니다"}
        />
        <Stat
          label="원화 환산"
          value={account?.estimatedKrwValue != null ? formatWon(account.estimatedKrwValue) : "—"}
          hint="USD 잔고 × 적용 환율 (추정)"
        />
      </div>

      <Card size="sm" className="border-dashed">
        <CardHeader>
          <CardDescription>환전 API</CardDescription>
          <CardTitle className="text-base">실제 KRW↔USD 환전 실행은 공식 지원되지 않습니다</CardTitle>
          <p className="text-sm text-muted-foreground">
            {audit?.implementation ??
              "환율·외화예수금·매수가능금액만 조회합니다. 가짜 환전 API를 호출하지 않습니다."}
          </p>
        </CardHeader>
      </Card>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="min-w-0">
          <CardHeader className="border-b">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>미국 주식</CardTitle>
                <CardDescription>NASDAQ · NYSE · AMEX · KIS 공식 시세/상품조회 · 읽기 전용</CardDescription>
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadSearch(query);
                  void loadAccount(query.includes(":") ? query : `NASDAQ:${query}`);
                }}
              >
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value.toUpperCase())}
                  placeholder="AAPL 또는 NASDAQ:AAPL"
                  className="sm:w-52"
                />
                <Button type="submit" size="sm" disabled={loading}>
                  조회
                </Button>
              </form>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>티커</TableHead>
                  <TableHead>거래소</TableHead>
                  <TableHead>현재가</TableHead>
                  <TableHead>등락률</TableHead>
                  <TableHead>통화</TableHead>
                  <TableHead>시장</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      {loading ? "해외 시세를 불러오는 중입니다." : "검색 결과가 없습니다. 티커를 입력하세요."}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((row) => {
                    const q = row.quote;
                    const active = selected?.instrument.symbol === row.instrument.symbol && selected.instrument.exchange === row.instrument.exchange;
                    return (
                      <TableRow
                        key={`${row.instrument.exchange}:${row.instrument.symbol}`}
                        className={active ? "bg-muted/50" : "cursor-pointer"}
                        onClick={() => setSelected(row)}
                      >
                        <TableCell>
                          <div className="font-medium">{row.instrument.symbol}</div>
                          <div className="text-xs text-muted-foreground">{row.instrument.displayName}</div>
                        </TableCell>
                        <TableCell>{row.instrument.exchange}</TableCell>
                        <TableCell className="tabular-nums">{q ? formatUsd(q.price) : "—"}</TableCell>
                        <TableCell className={q && q.changeRate > 0 ? "text-up" : q && q.changeRate < 0 ? "text-down" : ""}>
                          {q ? formatPct(q.changeRate) : "—"}
                        </TableCell>
                        <TableCell>{row.instrument.currency}</TableCell>
                        <TableCell>
                          <Badge variant={q?.marketStatus === "open" ? "default" : "outline"}>
                            {q ? marketLabel(q.marketStatus) : "—"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="border-b">
            <CardTitle>주문 영역</CardTitle>
            <CardDescription>PAPER Order Gate 이전에는 실행하지 않습니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4 text-sm">
            <Row label="Ticker" value={instrument?.symbol ?? "—"} />
            <Row label="Exchange" value={instrument?.exchange ?? "—"} />
            <Row label="USD Quote" value={quote ? formatUsd(quote.price) : "—"} />
            <Row label="USD Balance" value={usd ? formatUsd(usd.cash) : "—"} />
            <Row label="Orderable USD" value={account?.buyingPower ? formatUsd(account.buyingPower.orderableCash) : "—"} />
            <Row label="FX Rate" value={account?.fx ? `USD/KRW ${account.fx.rate.toLocaleString("ko-KR")}` : "—"} />
            <Row label="KRW Equivalent" value={account?.estimatedKrwValue != null ? formatWon(account.estimatedKrwValue) : "—"} />
            <div className="flex gap-2 pt-2">
              <Button
                className="flex-1"
                variant="outline"
                disabled
                aria-disabled
                title="해외 PAPER 주문 게이트가 열리기 전까지 비활성화"
              >
                BUY 잠금
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                disabled
                aria-disabled
                title="해외 PAPER 주문 게이트가 열리기 전까지 비활성화"
              >
                SELL 잠금
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              주문 버튼은 DISABLED 입니다. `RUN_KIS_VTS_OVERSEAS_ORDER_TESTS` 가 없어도 UI에서 주문을 내지 않습니다.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toast.message("해외 주문은 Overseas VTS-B opt-in 이후에만 실행됩니다.")}
            >
              주문 잠금 안내
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-base">해외 보유종목</CardTitle>
          <CardDescription>{account?.message ?? "KIS inquire-balance · 거래통화 USD 유지"}</CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          {!account?.positions.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">해외 보유 종목이 없습니다.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>종목</TableHead>
                  <TableHead>수량</TableHead>
                  <TableHead>평가</TableHead>
                  <TableHead>통화</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {account.positions.map((pos) => (
                  <TableRow key={pos.identity}>
                    <TableCell>
                      <div className="font-medium">{pos.instrument.displayName}</div>
                      <div className="text-xs text-muted-foreground">{pos.identity}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{pos.qty}</TableCell>
                    <TableCell className="tabular-nums">{formatUsd(pos.marketValue)}</TableCell>
                    <TableCell>{pos.currency}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; hint: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}
