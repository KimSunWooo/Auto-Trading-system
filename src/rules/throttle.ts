import { nowMs } from "@/src/clock";
import type { Allocation, AppState, OrderStatus } from "@/lib/types";
import { guardLog } from "@/src/rules/guard-log";

export const RULE_THROTTLE_MS = 3 * 60 * 1000;
export const RULE_THROTTLE_STREAK = 2;

const META_UNTIL = "throttleUntilMs";
const META_STREAK = "failStreak";
const META_TICKER = "failTicker";

export function ruleThrottleReason(
  alloc: Pick<Allocation, "ruleId" | "meta"> | undefined,
  ticker: string,
  now = nowMs(),
): string | null {
  if (!alloc?.meta) return null;
  const until = Number(alloc.meta[META_UNTIL] ?? 0);
  const lockedTicker = String(alloc.meta[META_TICKER] ?? "");
  if (!(until > now)) return null;
  if (lockedTicker && lockedTicker !== ticker) return null;
  const remainSec = Math.max(1, Math.ceil((until - now) / 1000));
  return `${alloc.ruleId} ${ticker} 쿨다운 ${remainSec}초 남음 (연속 실패/미체결).`;
}

function isThrottleableFailure(status: OrderStatus | undefined, reason: string | undefined): boolean {
  if (status === "pending" || status === "unknown" || status === "cancelled") return true;
  if (status !== "rejected") return false;
  const text = reason ?? "";
  if (text.includes("정규장")) return false;
  if (text.includes("이용 동의")) return false;
  if (text.includes("쿨다운")) return false;
  if (text.includes("긴급 정지")) return false;
  return true;
}

export function noteRuleOutcome(
  state: AppState,
  input: {
    ruleId?: string;
    ticker: string;
    status?: OrderStatus;
    reason?: string;
    ok?: boolean;
  },
  now = nowMs(),
): AppState {
  const ruleId = input.ruleId?.trim();
  if (!ruleId) return state;

  const success = input.ok === true || input.status === "filled";
  const fail = !success && isThrottleableFailure(input.status, input.reason);
  if (!success && !fail) return state;

  return {
    ...state,
    allocations: state.allocations.map((row) => {
      if (row.ruleId !== ruleId) return row;
      const tracked = String(row.meta?.[META_TICKER] ?? "");
      if (success) {
        if (tracked && tracked !== input.ticker) return row;
        return {
          ...row,
          meta: {
            ...(row.meta ?? {}),
            [META_UNTIL]: 0,
            [META_STREAK]: 0,
            [META_TICKER]: input.ticker,
          },
        };
      }
      if (Number(row.meta?.[META_UNTIL] ?? 0) > now) return row;
      const expired =
        Number(row.meta?.[META_UNTIL] ?? 0) > 0 && Number(row.meta?.[META_UNTIL] ?? 0) <= now;
      const same = tracked === input.ticker && !expired;
      const prev = same ? Number(row.meta?.[META_STREAK] ?? 0) : 0;
      const streak = prev + 1;
      const cooled = streak >= RULE_THROTTLE_STREAK;
      const until = cooled ? now + RULE_THROTTLE_MS : 0;
      if (streak === RULE_THROTTLE_STREAK) {
        guardLog(
          "룰 쿨다운",
          `${ruleId} ${input.ticker} 연속 ${streak}회 실패/미체결 → ${RULE_THROTTLE_MS / 1000}초 정지`,
        );
      }
      return {
        ...row,
        meta: {
          ...(row.meta ?? {}),
          [META_TICKER]: input.ticker,
          [META_STREAK]: streak,
          [META_UNTIL]: until,
        },
        lastMessage: cooled ? `${input.ticker} 연속 실패/미체결로 3분 쿨다운` : row.lastMessage,
      };
    }),
  };
}

export function guardMetaFrom(
  meta: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  if (!meta) return {};
  const out: Record<string, string | number | boolean | null> = {};
  if (meta[META_UNTIL] != null) out[META_UNTIL] = meta[META_UNTIL];
  if (meta[META_STREAK] != null) out[META_STREAK] = meta[META_STREAK];
  if (meta[META_TICKER] != null) out[META_TICKER] = meta[META_TICKER];
  return out;
}
