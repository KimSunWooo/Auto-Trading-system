"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { findStock } from "@/lib/universe";
import type { Quote } from "@/lib/types";
import { formatWon } from "@/lib/format";
import type { InstrumentSearchHit } from "@/src/instruments/types";

export type InstrumentPick = {
  /** Legacy 6-digit ticker when KR; otherwise symbol. */
  ticker: string;
  instrumentId?: string;
  instrumentKey?: string;
  displayName?: string;
  market?: string;
  country?: string;
};

export function InstrumentSearch({
  value,
  onChange,
  quotes,
  country,
  placeholder = "종목코드 또는 종목명 검색",
  legacySixDigitOnly = false,
}: {
  value: string;
  onChange: (next: string, pick?: InstrumentPick) => void;
  quotes?: Record<string, Quote>;
  country?: string;
  placeholder?: string;
  /** When true, keep 6-digit KR input path for conditions/DCA. */
  legacySixDigitOnly?: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [hits, setHits] = useState<InstrumentSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function scheduleSearch(next: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void runSearch(next);
    }, 300);
  }

  async function runSearch(next: string) {
    const q = next.trim();
    if (!q || (legacySixDigitOnly && /^\d+$/.test(q) && q.length < 2)) {
      setHits([]);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const params = new URLSearchParams({ q, limit: "20" });
      if (country) params.set("country", country);
      const res = await fetch(`/api/instruments/search?${params}`, {
        signal: ac.signal,
        credentials: "same-origin",
      });
      if (!res.ok) {
        setHits([]);
        return;
      }
      const body = (await res.json()) as { items?: InstrumentSearchHit[] };
      setHits(Array.isArray(body.items) ? body.items : []);
      setOpen(true);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  const legacyCode = legacySixDigitOnly
    ? /^\d+$/.test(query.trim())
      ? query.replace(/\D/g, "").slice(0, 6)
      : value.replace(/\D/g, "").slice(0, 6)
    : value;
  const stock =
    legacySixDigitOnly && legacyCode.length === 6 ? findStock(legacyCode) : undefined;
  const quote = quotes?.[legacySixDigitOnly ? legacyCode : value];

  function selectHit(hit: InstrumentSearchHit) {
    const ticker =
      hit.country === "KR" && /^\d{6}$/.test(hit.symbol) ? hit.symbol : hit.symbol;
    onChange(ticker, {
      ticker,
      instrumentId: hit.id,
      instrumentKey: hit.instrumentKey,
      displayName: hit.displayName,
      market: hit.market,
      country: hit.country,
    });
    setQuery(ticker);
    setOpen(false);
    setHits([]);
  }

  return (
    <div className="relative space-y-1">
      <Input
        inputMode={legacySixDigitOnly ? "numeric" : "search"}
        maxLength={legacySixDigitOnly ? 6 : 64}
        placeholder={placeholder}
        value={legacySixDigitOnly ? ( /^\d*$/.test(query.trim()) ? legacyCode : query) : query}
        onChange={(event) => {
          const raw = event.target.value;
          if (legacySixDigitOnly) {
            // Allow Korean/name search: do not strip non-digits from the query.
            // Only normalize to 6-digit ticker when the input is digits-only.
            const digitsOnly = /^\d*$/.test(raw.trim());
            if (!digitsOnly) {
              setQuery(raw);
              scheduleSearch(raw);
              setOpen(true);
              return;
            }
            const code = raw.replace(/\D/g, "").slice(0, 6);
            onChange(code);
            setQuery(code);
            scheduleSearch(code);
            return;
          }
          setQuery(raw);
          onChange(raw);
          scheduleSearch(raw);
        }}
        onFocus={() => {
          if (hits.length) setOpen(true);
        }}
        onBlur={() => {
          // Allow click on hit before closing.
          setTimeout(() => setOpen(false), 150);
        }}
        autoComplete="off"
      />
      {open && hits.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border bg-background shadow-sm">
          {hits.map((hit) => (
            <li key={hit.instrumentKey}>
              <button
                type="button"
                className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectHit(hit)}
              >
                <span>
                  <span className="font-medium">{hit.symbol}</span>
                  <span className="text-muted-foreground"> · {hit.displayName}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {hit.market}
                  {!hit.automationSupported ? " · 검색만" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {legacySixDigitOnly && legacyCode.length === 6 ? (
        <p className="text-xs text-muted-foreground">
          {stock?.name ?? hits[0]?.displayName ?? "직접 입력한 종목"}
          {quote ? ` · ${formatWon(quote.price)}` : ""}
          {busy ? " · 검색 중" : ""}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {busy ? "검색 중…" : "종목명·코드로 검색합니다. KIS 호출 없음."}
        </p>
      )}
    </div>
  );
}

/** Prefer InstrumentSearch — kept as alias for conditions/DCA with pick metadata. */
export function StockSelect(props: {
  value: string;
  onChange: (code: string, pick?: InstrumentPick) => void;
  quotes?: Record<string, Quote>;
}) {
  return (
    <InstrumentSearch
      value={props.value}
      onChange={(code, pick) => props.onChange(code, pick)}
      quotes={props.quotes}
      legacySixDigitOnly
      country="KR"
      placeholder="종목코드 6자리 또는 종목명 검색"
    />
  );
}
