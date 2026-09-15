"use client";

import { Input } from "@/components/ui/input";
import { findStock } from "@/lib/universe";
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
  const code = value.replace(/\D/g, "").slice(0, 6);
  const stock = code.length === 6 ? findStock(code) : undefined;
  const quote = quotes?.[code];

  return (
    <div className="space-y-1">
      <Input
        inputMode="numeric"
        maxLength={6}
        placeholder="종목코드 6자리 직접 입력"
        value={code}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      {code.length === 6 ? (
        <p className="text-xs text-muted-foreground">
          {stock?.name ?? "직접 입력한 종목"}
          {quote ? ` · ${formatWon(quote.price)}` : ""}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">미리 골라 둔 종목 목록은 없습니다.</p>
      )}
    </div>
  );
}
