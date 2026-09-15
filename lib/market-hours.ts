export type MarketClock = {
  now: Date;
  iso: string;
  /** Continuous regular session only: weekday 09:00 ≤ t < 15:20 KST. */
  open: boolean;
  sessionLabel: string;
  weekday: number;
  hhmm: number;
};

/** Tuesday 2026-09-15 10:00 Asia/Seoul — deterministic in-session clock for tests. */
export const SEOUL_REGULAR_SESSION_MS = Date.UTC(2026, 8, 15, 1, 0, 0);

function seoulParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[get("weekday")] ?? 0,
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

export function isRegularSession(now = new Date()): boolean {
  return getMarketClock(now).open;
}

export function getMarketClock(now = new Date()): MarketClock {
  const p = seoulParts(now);
  const hhmm = p.hour * 100 + p.minute;
  const weekday = p.weekday;
  const weekend = weekday === 0 || weekday === 6;
  const regular = !weekend && hhmm >= 900 && hhmm < 1520;
  const openingAuction = !weekend && hhmm >= 830 && hhmm < 900;
  const closingAuction = !weekend && hhmm >= 1520 && hhmm < 1530;
  const afterHours = !weekend && hhmm >= 1530 && hhmm < 1800;

  let sessionLabel = "정규장 종료";
  if (weekend) sessionLabel = "주말 휴장";
  else if (openingAuction || closingAuction) sessionLabel = "동시호가";
  else if (regular) sessionLabel = "정규장";
  else if (afterHours) sessionLabel = "시간외";
  else if (hhmm < 830) sessionLabel = "장 시작 전";

  return {
    now,
    iso: now.toISOString(),
    open: regular,
    sessionLabel,
    weekday,
    hhmm,
  };
}

export function addDaysIso(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
