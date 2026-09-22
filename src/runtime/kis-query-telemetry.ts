/**
 * Read-only KIS query telemetry (ring buffer).
 * Never records secrets, tokens, Authorization, or full account numbers.
 */
export type KisQueryCategory =
  | "quote"
  | "daily_closes"
  | "balance"
  | "psbl_order"
  | "open_orders"
  | "daily_ccld"
  | "other";

export type KisQueryErrorClass = "TRANSIENT" | "AUTH_CONFIG" | "DATA_INVALID" | "UNKNOWN";

export type KisQueryTelemetryEvent = {
  at: string;
  category: KisQueryCategory;
  trId?: string;
  ticker?: string;
  latencyMs: number;
  httpStatus?: number;
  msgCd?: string;
  timeout: boolean;
  rateLimited: boolean;
  ok: boolean;
  errorClass?: KisQueryErrorClass;
  /** Truncated, non-secret message */
  message?: string;
};

const MAX_EVENTS = 64;
const events: KisQueryTelemetryEvent[] = [];

export function classifyKisQueryError(input: {
  message?: string;
  httpStatus?: number;
  timeout?: boolean;
  msgCd?: string;
}): KisQueryErrorClass {
  const msg = String(input.message ?? "");
  const cd = String(input.msgCd ?? "");
  if (
    input.timeout ||
    /timeout|aborted|AbortError|ETIMEDOUT|ECONNRESET/i.test(msg) ||
    input.httpStatus === 429 ||
    cd === "EGW00201" ||
    /초당|거래건수|rate.?limit/i.test(msg)
  ) {
    return "TRANSIENT";
  }
  if (
    input.httpStatus === 401 ||
    input.httpStatus === 403 ||
    /token|credential|인증|권한|invalid.?app|APPKEY|APPSECRET|environment/i.test(msg)
  ) {
    return "AUTH_CONFIG";
  }
  if (/price\s*<=\s*0|malformed|invalid.?response|시세.*없/i.test(msg)) {
    return "DATA_INVALID";
  }
  if (input.httpStatus != null && input.httpStatus >= 500) return "TRANSIENT";
  return "UNKNOWN";
}

export function recordKisQueryTelemetry(
  event: Omit<KisQueryTelemetryEvent, "at"> & { at?: string },
): void {
  const row: KisQueryTelemetryEvent = {
    ...event,
    at: event.at ?? new Date().toISOString(),
    message: event.message ? event.message.slice(0, 200) : undefined,
  };
  events.push(row);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function listKisQueryTelemetry(): KisQueryTelemetryEvent[] {
  return [...events];
}

export function resetKisQueryTelemetryForTest(): void {
  events.length = 0;
}

export function isTransientQueryReason(reason: string | undefined): boolean {
  return classifyKisQueryError({ message: reason }) === "TRANSIENT";
}
