import type { CompareOp, ConditionStatus, Side, WatchBasis } from "./types";

const krw = new Intl.NumberFormat("ko-KR");
const krwFull = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

export function formatWon(n: number): string {
  return `${krw.format(Math.round(n))}원`;
}

export function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(n);
}

export function formatWonShort(n: number): string {
  return krwFull.format(Math.round(n));
}

export function formatQty(n: number): string {
  return `${krw.format(n)}주`;
}

export function formatCode(code: string): string {
  return code;
}

export function formatPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function changeRate(price: number, prevClose: number): number {
  if (!prevClose) return 0;
  return ((price - prevClose) / prevClose) * 100;
}

export function sideLabel(side: Side): string {
  return side === "buy" ? "매수" : "매도";
}

export function basisLabel(basis: WatchBasis): string {
  if (basis === "last") return "현재가";
  if (basis === "bid") return "매수1호가";
  return "매도1호가";
}

export function opLabel(op: CompareOp): string {
  return op === "gte" ? "이상" : "이하";
}

export function statusLabel(status: ConditionStatus): string {
  switch (status) {
    case "watching":
      return "감시중";
    case "paused":
      return "감시정지";
    case "filled":
      return "주문실행";
    case "expired":
      return "기간만료";
    case "rejected":
      return "오류";
    case "unknown":
      return "미확인";
    case "deleted":
      return "삭제";
  }
}

export function intervalLabel(sec: number): string {
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.round(sec / 60)}분`;
  if (sec < 86400) return `${Math.round(sec / 3600)}시간`;
  return `${Math.round(sec / 86400)}일`;
}

export function formatSeoul(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatSeoulDate(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
