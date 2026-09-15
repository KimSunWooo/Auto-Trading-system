"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSeoul, formatWon, sideLabel } from "@/lib/format";
import { ruleDisplayName } from "@/lib/dashboard";
import type { PublicState } from "@/lib/types";

const SOURCE: Record<string, string> = {
  condition: "조건매수",
  dca: "적립매수",
  manual: "수동",
  rule: "조건식",
};

export function OrdersPanel({ state }: { state: PublicState }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>자동주문 실행내역</CardTitle>
        <CardDescription>
          KIS 체결내역의 실제 체결 수량만 장부에 넣습니다. 미체결 잔량은 30초 후 취소합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {state.orders.length === 0 ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            아직 체결된 주문이 없습니다. 조건이 충족되거나 적립 주기가 되면 여기에 쌓입니다.
          </div>
        ) : (
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
                const resultLabel = order.status === "filled"
                  ? order.parentOrderId
                    ? "체결"
                    : (order.filledQty != null &&
                        order.orderedQty != null &&
                        order.filledQty < order.orderedQty)
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
                      {order.ruleId ? ` · ${ruleDisplayName(state.ruleConfig?.rules ?? [], order.ruleId)}` : ""}
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
                    {order.reason ? (
                      <div className="mt-1 max-w-40 truncate text-xs text-muted-foreground">
                        {order.reason}
                      </div>
                    ) : null}
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
