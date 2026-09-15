export function isIndeterminateError(err: unknown): boolean {
  if (err instanceof BrokerRejectError) return false;
  if (err && typeof err === "object" && "name" in err && String(err.name) === "BrokerRejectError") {
    return false;
  }
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const message = "message" in err ? String(err.message) : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    name === "IndeterminateOrderError"
  ) {
    return true;
  }
  return /timeout|timed out|aborted|fetch failed|econnreset|etimedout|network|socket|주문번호/i.test(
    message,
  );
}

export class OrderTimeoutError extends Error {
  readonly name = "TimeoutError";
  constructor(message = "주문 응답 시간 초과") {
    super(message);
  }
}

export class IndeterminateOrderError extends Error {
  readonly name = "IndeterminateOrderError";
  constructor(message: string) {
    super(message);
  }
}

export class BrokerRejectError extends Error {
  readonly name = "BrokerRejectError";
  constructor(message: string) {
    super(message);
  }
}
