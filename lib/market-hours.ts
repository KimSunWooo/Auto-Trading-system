export type MarketClock = {
  now: Date;
  iso: string;
  open: boolean;
  sessionLabel: string;
  weekday: number;
  hhmm: number;
};

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

export function getMarketClock(now = new Date()): MarketClock {
  const p = seoulParts(now);
  const hhmm = p.hour * 100 + p.minute;
  const weekday = p.weekday;
  const weekend = weekday === 0 || weekday === 6;
  const inSession = hhmm >= 900 && hhmm < 1530;
  const open = !weekend && inSession;

  let sessionLabel = "정규장 종료";
  if (weekend) sessionLabel = "주말 휴장";
  else if (hhmm < 900) sessionLabel = "장 시작 전";
  else if (inSession) sessionLabel = "정규장";
  else sessionLabel = "정규장 종료";

  return {
    now,
    iso: now.toISOString(),
    open,
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
