"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api } from "@/hooks/use-trading";
import { formatSeoul, formatWon, intervalLabel } from "@/lib/format";
import type { PublicState } from "@/lib/types";

const INTERVALS = [
  { value: "30", label: "30초 (데모)" },
  { value: "60", label: "1분" },
  { value: "300", label: "5분" },
  { value: "3600", label: "1시간" },
  { value: "86400", label: "1일" },
];

export function DcaPanel({
  state,
  onState,
}: {
  state: PublicState;
  onState: (next: PublicState) => void;
}) {
  const [code, setCode] = useState("");
  const [instrumentPick, setInstrumentPick] = useState<InstrumentPick | undefined>();
  const [amount, setAmount] = useState("100000");
  const [intervalSec, setIntervalSec] = useState("60");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      onState(
        await api<PublicState>("/api/dca", {
          method: "POST",
          body: JSON.stringify({
            code,
            instrumentId: instrumentPick?.instrumentId,
            instrumentKey: instrumentPick?.instrumentKey,
            amountKrw: Number(amount),
            intervalSec: Number(intervalSec),
          }),
        }),
      );
      toast.success("적립매수를 등록했습니다. 다음 주기에 1주 이상이면 매수합니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "등록에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>정기 적립매수</CardTitle>
          <CardDescription>
            같은 금액으로 나눠 삽니다. 금액이 1주 가격보다 작으면 해당 회차는 건너뜁니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-1.5">
            <Label>종목</Label>
            <StockSelect
              value={code}
              quotes={state.quotes}
              onChange={(next, pick) => {
                setCode(next);
                setInstrumentPick(pick);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>회차 금액</Label>
            <Input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>주기</Label>
            <Select value={intervalSec} onValueChange={(v) => setIntervalSec(String(v ?? "60"))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button className="w-full" disabled={busy} onClick={() => void create()}>
            <PlusIcon data-icon="inline-start" />
            적립 시작
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>적립 플랜</CardTitle>
          <CardDescription>켜두면 엔진이 주기에 맞춰 시장가 매수 주문을 넣습니다.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {state.dcaPlans.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center">
              <CalendarClockIcon className="size-8 text-muted-foreground" />
              <p className="font-medium">진행 중인 적립이 없습니다</p>
              <p className="text-sm text-muted-foreground">
                데모에서는 1분 주기로 바로 확인해 보세요.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>사용</TableHead>
                  <TableHead>종목</TableHead>
                  <TableHead>금액</TableHead>
                  <TableHead>주기</TableHead>
                  <TableHead>다음 매수</TableHead>
                  <TableHead>횟수</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.dcaPlans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <Switch
                        checked={plan.enabled}
                        onCheckedChange={(checked) =>
                          void api<PublicState>("/api/dca", {
                            method: "PATCH",
                            body: JSON.stringify({ id: plan.id, enabled: Boolean(checked) }),
                          }).then(onState)
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{plan.name}</div>
                      <div className="text-xs text-muted-foreground">{plan.code}</div>
                    </TableCell>
                    <TableCell>{formatWon(plan.amountKrw)}</TableCell>
                    <TableCell>{intervalLabel(plan.intervalSec)}</TableCell>
                    <TableCell>{formatSeoul(plan.nextRunAt)}</TableCell>
                    <TableCell>
                      {plan.runCount}회
                      {plan.lastMessage ? (
                        <div className="max-w-36 truncate text-xs text-muted-foreground">
                          {plan.lastMessage}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void api<PublicState>(`/api/dca?id=${plan.id}`, {
                            method: "DELETE",
                          }).then(onState)
                        }
                      >
                        삭제
                      </Button>
                    </TableCell>
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
