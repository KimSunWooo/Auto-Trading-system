"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { UsExchange } from "@/src/markets/overseas/instruments";
import type { CurrencyExchangeAudit } from "@/src/markets/overseas/types";

type CatalogInstrument = {
  symbol: string;
  name: string;
  exchange: UsExchange;
  currency: string;
  instrumentId?: string;
  instrumentKey?: string;
};

type SearchItem = { instrument: CatalogInstrument; quote: OverseasQuote | null };

type SearchResponse = {
  items: SearchItem[];
  catalogSource?: string;
  catalogComplete?: boolean;
  source?: string;
  message?: string;
  error?: string;
  kisCalls?: number;
  exchangeAudit?: CurrencyExchangeAudit;
  ordersEnabled?: boolean;
};

type AccountResponse = {
  account: OverseasAccountSnapshot | null;
  ordersEnabled?: boolean;
  exchangeAudit?: CurrencyExchangeAudit;
  error?: string;
  message?: string;
};

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
  const [kisCalls, setKisCalls] = useState(0);

  const loadAccount = useCallback(async (identity?: string) => {
    try {
      const qs = identity ? `?symbol=${encodeURIComponent(identity)}` : "";
      const data = await api<AccountResponse>(`/api/overseas/account${qs}`);
      if (data.account) setAccount(data.account);
      if (data.exchangeAudit) setAudit(data.exchangeAudit);
      if (data.error && !data.account) setError(data.error);
    } catch (err) {
      setError((current) => current ?? (err instanceof Error ? err.message : "외화 잔고를 불러오지 못했습니다."));
    }
  }, []);

  /** DB master autocomplete — 0 KIS calls. */
  const loadSearch = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const data = await api<SearchResponse>(`/api/overseas/search?q=${encodeURIComponent(q)}`);
      if (data.exchangeAudit) setAudit(data.exchangeAudit);
      setKisCalls(data.kisCalls ?? 0);
      setItems(data.items ?? []);
      setSelected(null);
      setError(data.error ?? data.message ?? null);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "해외주식 검색에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  /** After exact master row selection — one KIS quote. */
  const loadSelectedQuote = useCallback(async (row: CatalogInstrument) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        quote: "1",
        symbol: row.symbol,
        selectedExchange: row.exchange,
      });
      const data = await api<SearchResponse>(`/api/overseas/search?${params}`);
      if (data.exchangeAudit) setAudit(data.exchangeAudit);
      setKisCalls(data.kisCalls ?? 1);
      const next = data.items?.[0] ?? null;
      if (next) {
        setSelected(next);
        setItems((prev) =>
          prev.map((item) =>
            item.instrument.symbol === row.symbol && item.instrument.exchange === row.exchange
              ? next
              : item,
          ),
        );
        void loadAccount(`${row.exchange}:${row.symbol}`);
      }
      if (data.error) setError(data.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "해외 시세 조회에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, [loadAccount]);

  useEffect(() => {
    void loadSearch("AAPL");
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
                <CardDescription>
                  Instrument Master DB 검색 · 선택 후 KIS 시세 · 자동완성 KIS 호출 0
                </CardDescription>
              </div>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadSearch(query);
                }}
              >
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="AAPL / Apple / Microsoft"
                  className="sm:w-52"
                />
                <Button type="submit" size="sm" disabled={loading}>
                  검색
                </Button>
              </form>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
            <p className="mb-2 text-xs text-muted-foreground">autocomplete kisCalls={kisCalls}</p>
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
                      {loading ? "Master 검색 중…" : "검색 결과가 없습니다. 티커/이름을 입력하세요."}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((row) => {
                    const q = row.quote;
                    const active =
                      selected?.instrument.symbol === row.instrument.symbol &&
                      selected.instrument.exchange === row.instrument.exchange;
                    return (
                      <TableRow
                        key={`${row.instrument.exchange}:${row.instrument.symbol}`}
                        className={active ? "bg-muted/50" : "cursor-pointer"}
                        onClick={() => void loadSelectedQuote(row.instrument)}
                      >
                        <TableCell>
                          <div className="font-medium">{row.instrument.symbol}</div>
                          <div className="text-xs text-muted-foreground">{row.instrument.name}</div>
                        </TableCell>
                        <TableCell>{row.instrument.exchange}</TableCell>
                        <TableCell className="tabular-nums">
                          {q ? formatUsd(q.price) : "선택 후 조회"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {q ? formatPct(q.changeRate) : "—"}
                        </TableCell>
                        <TableCell>{row.instrument.currency}</TableCell>
                        <TableCell>
                          {q ? <Badge variant="outline">{marketLabel(q.marketStatus)}</Badge> : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>선택 종목</CardTitle>
            <CardDescription>
              {instrument
                ? `${instrument.exchange}:${instrument.symbol} · Master exchange 유지`
                : "행을 클릭하면 Master exchange로 KIS 시세를 조회합니다"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {instrument ? (
              <>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">이름</span>
                  <span>{instrument.name}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">거래소</span>
                  <span>{instrument.exchange}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">현재가</span>
                  <span className="tabular-nums">{quote ? formatUsd(quote.price) : "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">등락</span>
                  <span className="tabular-nums">{quote ? formatPct(quote.changeRate) : "—"}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">검색 후 종목을 선택하세요.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card size="sm">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-lg tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
