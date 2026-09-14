"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UNIVERSE } from "@/lib/universe";
import type { Quote } from "@/lib/types";
import { formatWon } from "@/lib/format";

export function StockSelect({
  value,
  onChange,
  quotes,
}: {
  value: string;
  onChange: (code: string) => void;
  quotes?: Record<string, Quote>;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
      <SelectTrigger className="w-full min-w-0">
        <SelectValue placeholder="종목 선택" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start" className="min-w-72">
        {UNIVERSE.map((stock) => {
          const quote = quotes?.[stock.code];
          return (
            <SelectItem key={stock.code} value={stock.code}>
              <span className="flex w-full items-center justify-between gap-4">
                <span>
                  {stock.name}{" "}
                  <span className="text-muted-foreground">{stock.code}</span>
                </span>
                {quote ? (
                  <span className="tabular-nums text-muted-foreground">
                    {formatWon(quote.price)}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
