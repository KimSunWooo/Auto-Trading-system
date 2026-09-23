"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PlusIcon, RadarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StockSelect } from "@/components/stock-select";
import type { InstrumentPick } from "@/components/stock-select";
import { Price } from "@/components/price";
import { api } from "@/hooks/use-trading";
import {
  basisLabel,
  formatSeoulDate,
  formatWon,
  opLabel,
  sideLabel,
  statusLabel,
} from "@/lib/format";
import type {
  CompareOp,
  OrderPriceType,
  PublicState,
  Side,
  WatchBasis,
} from "@/lib/types";

export function ConditionsPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [instrumentId, setInstrumentId] = useState<string | undefined>();
  const [instrumentKey, setInstrumentKey] = useState<string | undefined>();
  const [side, setSide] = useState<Side>("buy");
  const [watchBasis, setWatchBasis] = useState<WatchBasis>("last");
  const [operator, setOperator] = useState<CompareOp>("lte");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [qty, setQty] = useState("10");
  const [orderPriceType, setOrderPriceType] = useState<OrderPriceType>("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [volumeEnabled, setVolumeEnabled] = useState(false);
  const [volumeOp, setVolumeOp] = useState<CompareOp>("gte");
  const [volume, setVolume] = useState("1000000");
  const [expireDays, setExpireDays] = useState("30");

  const quote = state.quotes[code];

  const preview = useMemo(() => {
    if (!quote) return "";
    const price = triggerPrice || String(quote.price);
    return `${quote.name} ${basisLabel(watchBasis)}가 ${formatWon(Number(price) || quote.price)} ${opLabel(operator)}이면 ${sideLabel(side)} ${qty}주`;
  }, [operator, qty, quote, side, triggerPrice, watchBasis]);

  function resetForm(nextCode = code, pick?: InstrumentPick) {
    const next = state.quotes[nextCode];
    setCode(nextCode);
    setInstrumentId(pick?.instrumentId);
    setInstrumentKey(pick?.instrumentKey);
    setTriggerPrice(next ? String(next.price) : "");
    setLimitPrice(next ? String(next.price) : "");
    setQty("10");
    setSide("buy");
    setWatchBasis("last");
    setOperator("lte");
    setOrderPriceType("market");
    setVolumeEnabled(false);
    setExpireDays("30");
  }

  async function submit() {
    setBusy(true);
    try {
      const next = await api<PublicState>("/api/conditions", {
        method: "POST",
        body: JSON.stringify({
          code,
          instrumentId,
          instrumentKey,
          side,
          watchBasis,
          operator,
          triggerPrice: Number(triggerPrice),
          volumeEnabled,
          volumeOp,
          volume: Number(volume),
          qty: Number(qty),
          orderPriceType,
          limitPrice: orderPriceType === "limit" ? Number(limitPrice) : null,
          expireDays: Number(expireDays),
        }),
      });
      onState(next);
      setOpen(false);
      toast.success("감시 조건을 등록했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "등록에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, watching: boolean) {
    try {
      onState(
        await api<PublicState>("/api/conditions", {
          method: "PATCH",
          body: JSON.stringify({ id, watching }),
        }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "변경에 실패했습니다.");
    }
  }

  async function remove(id: string) {
    try {
      onState(await api<PublicState>(`/api/conditions?id=${id}`, { method: "DELETE" }));
      toast.success("조건을 삭제했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "삭제할 수 없습니다.");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>서버자동주문</CardTitle>
              <CardDescription>
                조건가격에 닿으면 한 번 주문을 냅니다. 브로커가 KIS이면 한국투자증권으로 나갑니다.
                감시 중인 조건은 삭제할 수 없습니다.
              </CardDescription>
            </div>
            <Button
              onClick={() => {
                resetForm(code);
                setOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              신규 조건
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {state.conditions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-12 text-center">
              <RadarIcon className="size-8 text-muted-foreground" />
              <div>
                <p className="font-medium">등록된 감시 조건이 없습니다</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  종목코드 6자리와 조건가격을 직접 입력하세요.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setOpen(true)}>조건 만들기</Button>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>감시</TableHead>
                  <TableHead>종목</TableHead>
                  <TableHead>조건</TableHead>
                  <TableHead>주문</TableHead>
                  <TableHead>만료</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.conditions.map((cond) => {
                  const live = state.quotes[cond.code];
                  const locked = cond.status === "filled";
                  return (
                    <TableRow key={cond.id}>
                      <TableCell>
                        <Switch
                          checked={cond.watching}
                          disabled={locked || cond.status === "expired" || cond.status === "rejected"}
                          onCheckedChange={(checked) => void toggle(cond.id, Boolean(checked))}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{cond.name}</div>
                        <div className="text-xs text-muted-foreground">{cond.code}</div>
                      </TableCell>
                      <TableCell>
                        <div>
                          {basisLabel(cond.watchBasis)} {formatWon(cond.triggerPrice)}{" "}
                          {opLabel(cond.operator)}
                        </div>
                        {live ? (
                          <div className="text-xs text-muted-foreground">
                            현재 <Price value={live.price} prevClose={live.prevClose} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className={cond.side === "buy" ? "text-up" : "text-down"}>
                          {sideLabel(cond.side)}
                        </span>{" "}
                        {cond.qty}주 · {cond.orderPriceType === "market" ? "현재가" : `지정 ${formatWon(cond.limitPrice ?? 0)}`}
                      </TableCell>
                      <TableCell>{formatSeoulDate(cond.expiresAt)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            cond.status === "watching"
                              ? "default"
                              : cond.status === "filled"
                                ? "secondary"
                                : cond.status === "rejected"
                                  ? "destructive"
                                  : "outline"
                          }
                        >
                          {statusLabel(cond.status)}
                        </Badge>
                        {cond.message ? (
                          <div className="mt-1 max-w-40 truncate text-xs text-muted-foreground">
                            {cond.message}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cond.watching && cond.status === "watching"}
                          onClick={() => void remove(cond.id)}
                        >
                          삭제
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>주문조건 설정</DialogTitle>
            <DialogDescription>
              감시기준이 조건가격에 도달하면 아래 주문조건으로 1회 발주합니다. 유효기간은 최대 90일입니다.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>종목</Label>
              <StockSelect
                value={code}
                quotes={state.quotes}
                onChange={(nextCode, pick) => {
                  setCode(nextCode);
                  setInstrumentId(pick?.instrumentId);
                  setInstrumentKey(pick?.instrumentKey);
                  const next = state.quotes[nextCode];
                  if (next) {
                    setTriggerPrice(String(next.price));
                    setLimitPrice(String(next.price));
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>매매구분</Label>
              <Select value={side} onValueChange={(v) => setSide((v as Side) ?? "buy")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="buy">매수</SelectItem>
                  <SelectItem value="sell">매도</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>수량</Label>
              <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>감시기준</Label>
              <Select
                value={watchBasis}
                onValueChange={(v) => setWatchBasis((v as WatchBasis) ?? "last")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="last">현재가</SelectItem>
                  <SelectItem value="bid">매수1호가</SelectItem>
                  <SelectItem value="ask">매도1호가</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>조건</Label>
              <Select
                value={operator}
                onValueChange={(v) => setOperator((v as CompareOp) ?? "lte")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lte">이하</SelectItem>
                  <SelectItem value="gte">이상</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>조건가격</Label>
              <Input
                inputMode="numeric"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>주문호가</Label>
              <Select
                value={orderPriceType}
                onValueChange={(v) => setOrderPriceType((v as OrderPriceType) ?? "market")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="market">현재가</SelectItem>
                  <SelectItem value="limit">지정가</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {orderPriceType === "limit" ? (
              <div className="space-y-1.5">
                <Label>지정가격</Label>
                <Input
                  inputMode="numeric"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>조건기간</Label>
                <Input
                  inputMode="numeric"
                  value={expireDays}
                  onChange={(e) => setExpireDays(e.target.value)}
                />
              </div>
            )}
            {orderPriceType === "limit" ? (
              <div className="space-y-1.5">
                <Label>조건기간 (일)</Label>
                <Input
                  inputMode="numeric"
                  value={expireDays}
                  onChange={(e) => setExpireDays(e.target.value)}
                />
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:col-span-2">
              <div>
                <Label htmlFor="vol">거래량 조건</Label>
                <p className="text-xs text-muted-foreground">입력한 거래량 이상/이하일 때만 발주</p>
              </div>
              <Switch
                id="vol"
                checked={volumeEnabled}
                onCheckedChange={(c) => setVolumeEnabled(Boolean(c))}
              />
            </div>
            {volumeEnabled ? (
              <>
                <div className="space-y-1.5">
                  <Label>거래량 비교</Label>
                  <Select
                    value={volumeOp}
                    onValueChange={(v) => setVolumeOp((v as CompareOp) ?? "gte")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gte">이상</SelectItem>
                      <SelectItem value="lte">이하</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>거래량</Label>
                  <Input
                    inputMode="numeric"
                    value={volume}
                    onChange={(e) => setVolume(e.target.value)}
                  />
                </div>
              </>
            ) : null}
          </div>
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">{preview}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              신규저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
