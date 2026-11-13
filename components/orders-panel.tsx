"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSeoul, formatWon, sideLabel } from "@/lib/format";
import { api, ApiError } from "@/hooks/use-trading";
import type { PublicState } from "@/lib/types";

const SOURCE: Record<string, string> = {
  condition: "조건매수",
  dca: "적립매수",
  manual: "수동",
  rule: "자동",
  interval: "자동",
  INTENT: "자동",
};

type FillRow = {
  executionId: string;
  side: string;
  symbol: string;
  displayName: string;
  quantity: number;
  price: number;
  grossAmount: number;
  currency: string;
  brokerOrderNo: string | null;
  executedAt: string;
  orderSource: string | null;
  orderedQty: number | null;
  filledQtyOnOrder: number | null;
};

type FillsResponse = {
  ok?: boolean;
  status?: string;
  items?: FillRow[];
  nextCursor?: string | null;
  error?: string;
  range?: { fromDate: string; throughDate: string };
};

export function OrdersPanel({ state }: { state: PublicState }) {
  const [fills, setFills] = useState<FillRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "empty" | "rds_fail" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [range, setRange] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(nextCursor?: string | null, append = false) {
      try {
        if (!append) setStatus("loading");
        const qs = new URLSearchParams({ limit: "50", days: "90" });
        if (nextCursor) qs.set("cursor", nextCursor);
        const page = await api<FillsResponse>(`/api/history/fills?${qs.toString()}`);
        if (cancelled) return;
        const items = page.items ?? [];
        setFills((prev) => (append && prev ? [...prev, ...items] : items));
        setCursor(page.nextCursor ?? null);
        if (page.range) setRange(`${page.range.fromDate} ~ ${page.range.throughDate} (KST)`);
        if (page.status === "empty" || items.length === 0) {
          setStatus("empty");
          setMessage("거래 없음 — 선택한 기간에 RDS 체결 기록이 없습니다.");
        } else {
          setStatus("ok");
          setMessage(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          setStatus("rds_fail");
          setMessage(err.message || "RDS 조회 실패");
        } else {
          setStatus("error");
          setMessage(err instanceof Error ? err.message : "체결내역을 불러오지 못했습니다.");
        }
        // Fall back to in-memory state.orders so the tab is never blank if RDS fails mid-session.
        if (!fills && state.orders.length > 0) {
          setFills(null);
        }
      }
    }
    void load(null, false);
    return () => {
      cancelled = true;
    };
    // Load once on tab mount — not on every dashboard poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showLedgerFallback = fills === null && state.orders.length > 0;

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>체결내역</CardTitle>
            <CardDescription>
              RDS 장부 기준 수동·자동 매수/매도 및 부분체결입니다.
              {range ? ` · ${range}` : ""}
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/reports/trades">거래 리포트</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {status === "loading" && fills === null ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            RDS 체결내역을 불러오는 중…
          </div>
        ) : status === "rds_fail" || status === "error" ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              {message}
            </div>
            {showLedgerFallback ? <LocalOrdersFallback state={state} /> : null}
          </div>
        ) : status === "empty" && !showLedgerFallback ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            {message ?? "거래 없음"}
          </div>
        ) : fills && fills.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>시각</TableHead>
                  <TableHead>원천</TableHead>
                  <TableHead>종목</TableHead>
                  <TableHead>구분</TableHead>
                  <TableHead>수량</TableHead>
                  <TableHead>단가</TableHead>
                  <TableHead>금액</TableHead>
                  <TableHead>결과</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fills.map((fill) => {
                  const partial =
                    fill.orderedQty != null &&
                    fill.filledQtyOnOrder != null &&
                    fill.filledQtyOnOrder > 0 &&
                    fill.filledQtyOnOrder < fill.orderedQty;
                  const qtyLabel = partial
                    ? `${fill.quantity} (누적 ${fill.filledQtyOnOrder}/${fill.orderedQty})`
                    : String(fill.quantity);
                  return (
                    <TableRow key={fill.executionId}>
                      <TableCell>
                        {formatSeoul(
                          fill.executedAt.includes("T")
                            ? fill.executedAt.endsWith("Z")
                              ? fill.executedAt
                              : `${fill.executedAt}Z`
                            : `${fill.executedAt.replace(" ", "T")}Z`,
                        )}
                      </TableCell>
                      <TableCell>
                        {SOURCE[fill.orderSource ?? ""] ?? fill.orderSource ?? "장부"}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{fill.displayName}</div>
                        <div className="text-xs text-muted-foreground">
                          {fill.symbol}
                          {fill.brokerOrderNo ? ` · ${fill.brokerOrderNo}` : ""}
                        </div>
                      </TableCell>
                      <TableCell
                        className={
                          fill.side.toUpperCase() === "BUY" ? "text-up" : "text-down"
                        }
                      >
                        {sideLabel(fill.side.toLowerCase() === "sell" ? "sell" : "buy")}
                      </TableCell>
                      <TableCell className="tabular-nums">{qtyLabel}</TableCell>
                      <TableCell className="tabular-nums">
                        {fill.currency === "USD" ? fill.price.toFixed(2) : formatWon(fill.price)}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {fill.currency === "USD"
                          ? fill.grossAmount.toFixed(2)
                          : formatWon(fill.grossAmount)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{partial ? "부분체결" : "체결"}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {cursor ? (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const qs = new URLSearchParams({ limit: "50", days: "90", cursor });
                      const page = await api<FillsResponse>(`/api/history/fills?${qs}`);
                      setFills((prev) => [...(prev ?? []), ...(page.items ?? [])]);
                      setCursor(page.nextCursor ?? null);
                    })();
                  }}
                >
                  더 보기
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <LocalOrdersFallback state={state} />
        )}
      </CardContent>
    </Card>
  );
}

function LocalOrdersFallback({ state }: { state: PublicState }) {
  if (state.orders.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
        아직 체결된 주문이 없습니다.
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>시각</TableHead>
          <TableHead>원천</TableHead>
          <TableHead>종목</TableHead>
          <TableHead>구분</TableHead>
          <TableHead>수량</TableHead>
          <TableHead>단가</TableHead>
          <TableHead>금액</TableHead>
          <TableHead>결과</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.orders.map((order) => {
          const ordered = order.orderedQty ?? order.qty;
          const filled = order.filledQty;
          const qtyLabel =
            order.parentOrderId
              ? String(order.qty)
              : filled != null && filled !== ordered
                ? `${filled}/${ordered}`
                : order.status === "pending" || order.status === "unknown"
                  ? `${filled ?? 0}/${ordered}`
                  : String(order.qty);
          const resultLabel =
            order.status === "filled"
              ? order.parentOrderId
                ? "체결"
                : order.filledQty != null &&
                    order.orderedQty != null &&
                    order.filledQty < order.orderedQty
                  ? "부분체결"
                  : "체결"
              : order.status === "pending"
                ? "대기"
                : order.status === "unknown"
                  ? "미확인"
                  : order.status === "cancelled"
                    ? "취소"
                    : "거부";
          return (
            <TableRow key={order.id}>
              <TableCell>{formatSeoul(order.createdAt)}</TableCell>
              <TableCell>{SOURCE[order.source] ?? order.source}</TableCell>
              <TableCell>
                <div className="font-medium">{order.name}</div>
                <div className="text-xs text-muted-foreground">
                  {order.code}
                  {order.brokerOrderNo ? ` · ${order.brokerOrderNo}` : ""}
                </div>
              </TableCell>
              <TableCell className={order.side === "buy" ? "text-up" : "text-down"}>
                {sideLabel(order.side)}
              </TableCell>
              <TableCell className="tabular-nums">{qtyLabel}</TableCell>
              <TableCell className="tabular-nums">{formatWon(order.price)}</TableCell>
              <TableCell className="tabular-nums">{formatWon(order.net)}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    order.status === "filled"
                      ? "secondary"
                      : order.status === "pending"
                        ? "outline"
                        : "destructive"
                  }
                >
                  {resultLabel}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
