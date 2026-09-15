import { cn } from "@/lib/utils";
import { changeRate, formatPct, formatWon } from "@/lib/format";

export function toneClass(delta: number) {
  if (delta > 0) return "text-up";
  if (delta < 0) return "text-down";
  return "text-muted-foreground";
}

export function Price({
  value,
  prevClose,
  className,
}: {
  value: number;
  prevClose?: number;
  className?: string;
}) {
  const delta = prevClose == null ? 0 : value - prevClose;
  return (
    <span className={cn("tabular-nums font-medium", toneClass(delta), className)}>
      {formatWon(value)}
    </span>
  );
}

export function Change({
  price,
  prevClose,
  className,
}: {
  price: number;
  prevClose: number;
  className?: string;
}) {
  const delta = price - prevClose;
  const pct = changeRate(price, prevClose);
  return (
    <span className={cn("tabular-nums", toneClass(delta), className)}>
      {delta > 0 ? "▲" : delta < 0 ? "▼" : "–"} {formatPct(pct)}
    </span>
  );
}

export function Sparkline({
  values,
  width = 96,
  height = 32,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = width;
  const h = height;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      className={cn("overflow-visible", className)}
    >
      <polyline
        fill="none"
        stroke={up ? "var(--price-up)" : "var(--price-down)"}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
    </svg>
  );
}
