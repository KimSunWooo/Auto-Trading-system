export type MarketClock = {
  now: Date;
  iso: string;
  /** Continuous regular session only: weekday 09:00 ≤ t < 15:20 KST, not a KRX holiday. */
  open: boolean;
  sessionLabel: string;
  weekday: number;
  hhmm: number;
  holiday: boolean;
};

/** KRX closed dates (YYYY-MM-DD in Asia/Seoul). Weekends are handled separately. */
export const KRX_HOLIDAYS = new Set([
  "2025-01-01",
  "2025-01-27",
  "2025-01-28",
  "2025-01-29",
  "2025-01-30",
  "2025-03-01",
  "2025-03-03",
  "2025-05-01",
  "2025-05-05",
  "2025-05-06",
  "2025-06-03",
  "2025-06-06",
  "2025-08-15",
  "2025-10-03",
  "2025-10-05",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",
  "2025-10-09",
  "2025-12-25",
  "2025-12-31",
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-03-01",
  "2026-03-02",
  "2026-05-01",
  "2026-05-05",
  "2026-05-24",
  "2026-05-25",
  "2026-06-06",
  "2026-08-15",
  "2026-08-17",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-10-03",
  "2026-10-05",
  "2026-10-09",
  "2026-12-25",
  "2026-12-31",
  "2027-01-01",
]);

/** Tuesday 2026-09-15 10:00 Asia/Seoul — deterministic in-session clock for tests. */
export const SEOUL_REGULAR_SESSION_MS = Date.UTC(2026, 8, 15, 1, 0, 0);
/** Tuesday 2026-09-15 08:45 Asia/Seoul — opening auction. */
export const SEOUL_OPENING_AUCTION_MS = Date.UTC(2026, 8, 14, 23, 45, 0);
/** Tuesday 2026-09-15 15:20 Asia/Seoul — closing auction. */
export const SEOUL_CLOSING_AUCTION_MS = Date.UTC(2026, 8, 15, 6, 20, 0);
/** Saturday 2026-09-19 10:00 Asia/Seoul. */
export const SEOUL_WEEKEND_MS = Date.UTC(2026, 8, 19, 1, 0, 0);
/** Friday 2026-10-09 10:00 Asia/Seoul — Hangul Day. */
export const SEOUL_HOLIDAY_MS = Date.UTC(2026, 9, 9, 1, 0, 0);

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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function seoulDateKey(now = new Date()): string {
  const p = seoulParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isKrHoliday(now = new Date()): boolean {
  return KRX_HOLIDAYS.has(seoulDateKey(now));
}

export function getMarketClock(now = new Date()): MarketClock {
  const p = seoulParts(now);
  const hhmm = p.hour * 100 + p.minute;
  const weekday = p.weekday;
  const weekend = weekday === 0 || weekday === 6;
  const holiday = isKrHoliday(now);
  const closedDay = weekend || holiday;
  const regular = !closedDay && hhmm >= 900 && hhmm < 1520;
  const openingAuction = !closedDay && hhmm >= 830 && hhmm < 900;
  const closingAuction = !closedDay && hhmm >= 1520 && hhmm < 1530;
  const afterHours = !closedDay && hhmm >= 1530 && hhmm < 1800;

  let sessionLabel = "정규장 종료";
  if (weekend) sessionLabel = "주말 휴장";
  else if (holiday) sessionLabel = "공휴일 휴장";
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
    holiday,
  };
}

export function addDaysIso(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
