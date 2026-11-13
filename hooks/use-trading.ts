"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicState } from "@/lib/types";

export type ApiErrorPayload = {
  error?: string;
  errorCode?: string;
  message?: string;
  blockers?: Array<{ code: string; message: string; retryable?: boolean } | string>;
  checks?: Record<string, string>;
  retryAfterMs?: number;
  readyForPaperAutoTrading?: boolean;
  firstFailureStage?: string | null;
  firstFailureReason?: string | null;
};

export type AutoTradingStartPoll = {
  requestId: string;
  status:
    | "queued"
    | "running"
    | "reconciling"
    | "completed"
    | "failed"
    | "cancelled"
    | "idle"
    | "lost";
  uiStatus: string;
  stage?: string;
  message?: string;
  totalMs?: number | null;
  byStage?: Record<string, number>;
  autoTradingOnInRds?: boolean | null;
  firstFailureStage?: string | null;
  firstFailureReason?: string | null;
  blockers?: ApiErrorPayload["blockers"];
  checks?: Record<string, string>;
  error?: string;
  pollUrl?: string;
  reused?: boolean;
  asyncStart?: boolean;
  errorCode?: string;
  previousRequestStatus?: "unknown";
  accountAutoTrading?: boolean | null;
  accountAutoTradingSource?: "rds" | "unavailable";
  autoRetransmit?: boolean;
};

export class ApiError extends Error {
  status: number;
  payload?: ApiErrorPayload;
  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export function formatPreflightBlockers(err: ApiError): string {
  const blockers = err.payload?.blockers;
  if (!blockers?.length) return err.message;
  const lines = blockers.map((b) => {
    if (typeof b === "string") return `• ${b}`;
    return `• ${b.message || b.code}${b.retryable ? " (잠시 후 재시도)" : ""}`;
  });
  const header =
    err.payload?.errorCode === "PAPER_PREFLIGHT_BLOCKED"
      ? "PAPER 자동매매를 아직 시작할 수 없습니다."
      : err.payload?.message || err.message;
  return [header, ...lines].join("\n");
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!text.trim()) {
    throw new ApiError(
      res.ok ? "서버 응답이 비었습니다." : "요청에 실패했습니다. 예수금 합계를 확인하세요.",
      res.status || 500,
    );
  }
  let data: T & ApiErrorPayload;
  try {
    data = JSON.parse(text) as T & ApiErrorPayload;
  } catch {
    throw new ApiError("서버가 JSON이 아닌 응답을 보냈습니다.", res.status || 500);
  }
  if (!res.ok) {
    const message =
      data.message && data.errorCode === "PAPER_PREFLIGHT_BLOCKED"
        ? data.message
        : (data.error ?? data.message ?? "요청에 실패했습니다.");
    throw new ApiError(message, res.status, {
      error: data.error,
      errorCode: data.errorCode,
      message: data.message,
      blockers: data.blockers,
      checks: data.checks,
      retryAfterMs: data.retryAfterMs,
      readyForPaperAutoTrading: data.readyForPaperAutoTrading,
      firstFailureStage: data.firstFailureStage,
      firstFailureReason: data.firstFailureReason,
    });
  }
  return data;
}

/**
 * Poll once; 404 START_REQUEST_LOST is returned as a recovery payload (not thrown),
 * so callers can stop waiting without auto-retransmitting start.
 */
async function pollStartRequest(
  requestId: string,
  signal?: AbortSignal,
): Promise<{ poll: AutoTradingStartPoll; lost: boolean }> {
  const res = await fetch(
    `/api/auto-trading/start?requestId=${encodeURIComponent(requestId)}`,
    { signal, headers: { "Content-Type": "application/json" } },
  );
  const text = await res.text();
  let body: AutoTradingStartPoll;
  try {
    body = JSON.parse(text || "{}") as AutoTradingStartPoll;
  } catch {
    throw new ApiError("서버가 JSON이 아닌 응답을 보냈습니다.", res.status || 500);
  }
  if (res.status === 404 && body.errorCode === "START_REQUEST_LOST") {
    return { poll: { ...body, requestId: body.requestId || requestId, status: "lost" }, lost: true };
  }
  if (!res.ok) {
    throw new ApiError(body.error || body.message || "시작 상태 조회에 실패했습니다.", res.status, body);
  }
  return { poll: body, lost: false };
}

function recoveryFromLostRequest(lost: AutoTradingStartPoll): AutoTradingStartPoll {
  return {
    ...lost,
    status: "lost",
    uiStatus: lost.uiStatus || "확인 불가",
    autoTradingOnInRds:
      lost.accountAutoTradingSource === "rds" ? Boolean(lost.accountAutoTrading) : null,
    autoRetransmit: false,
  };
}

/**
 * Enqueue async PAPER auto-trading start and poll until terminal status.
 * onProgress receives uiStatus strings like "장부 대사 중".
 * Lost requestId after restart → stop waiting, show current RDS ON/OFF, never re-POST.
 */
export async function startAutoTradingAsync(opts: {
  disclaimerAccepted?: boolean;
  onProgress?: (poll: AutoTradingStartPoll) => void;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<AutoTradingStartPoll> {
  const pollMs = opts.pollMs ?? 750;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const started = Date.now();

  const enqueue = await fetch("/api/auto-trading/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disclaimerAccepted: opts.disclaimerAccepted !== false }),
    signal: opts.signal,
  });
  const enqueueText = await enqueue.text();
  let poll = JSON.parse(enqueueText || "{}") as AutoTradingStartPoll;
  if (!enqueue.ok && enqueue.status !== 202) {
    throw new ApiError(poll.error || poll.message || "시작 요청에 실패했습니다.", enqueue.status, poll);
  }
  opts.onProgress?.(poll);

  while (
    poll.status === "queued" ||
    poll.status === "running" ||
    poll.status === "reconciling"
  ) {
    if (opts.signal?.aborted) {
      throw new ApiError("시작 요청이 취소되었습니다.", 499);
    }
    if (Date.now() - started > timeoutMs) {
      const last = await pollStartRequest(poll.requestId, opts.signal);
      opts.onProgress?.(last.lost ? recoveryFromLostRequest(last.poll) : last.poll);
      if (last.lost) {
        const recovered = recoveryFromLostRequest(last.poll);
        if (recovered.accountAutoTradingSource === "unavailable") {
          throw new ApiError(recovered.message || "확인 불가", 404, recovered);
        }
        // Response loss after possible ON — report current account state, do not re-POST.
        if (recovered.accountAutoTrading === true) {
          return {
            ...recovered,
            status: "completed",
            uiStatus: "시작 완료",
            autoTradingOnInRds: true,
            message:
              "시작 요청 상태는 유실됐지만 현재 계좌는 RDS에서 ON 입니다. (이전 요청 완료 여부는 알 수 없음)",
          };
        }
        throw new ApiError(
          recovered.message || "시작 요청이 유실되었고 현재 계좌는 OFF 입니다.",
          404,
          recovered,
        );
      }
      if (last.poll.status === "completed" && last.poll.autoTradingOnInRds) return last.poll;
      throw new ApiError(
        last.poll.message || "시작 응답이 지연되어 서버 상태를 다시 확인해 주세요.",
        408,
        last.poll,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
    const next = await pollStartRequest(poll.requestId, opts.signal);
    if (next.lost) {
      const recovered = recoveryFromLostRequest(next.poll);
      opts.onProgress?.(recovered);
      if (recovered.accountAutoTradingSource === "unavailable") {
        throw new ApiError(recovered.message || "확인 불가", 404, recovered);
      }
      if (recovered.accountAutoTrading === true) {
        return {
          ...recovered,
          status: "completed",
          uiStatus: "시작 완료",
          autoTradingOnInRds: true,
          message:
            "시작 요청 상태는 유실됐지만 현재 계좌는 RDS에서 ON 입니다. (이전 요청 완료 여부는 알 수 없음)",
        };
      }
      throw new ApiError(
        recovered.message || "시작 요청이 유실되었고 현재 계좌는 OFF 입니다.",
        404,
        recovered,
      );
    }
    poll = next.poll;
    opts.onProgress?.(poll);
  }

  if (poll.status === "completed" && poll.autoTradingOnInRds) return poll;
  if (poll.status === "cancelled") {
    throw new ApiError(poll.message || "시작이 취소되었습니다.", 409, poll);
  }
  throw new ApiError(
    poll.firstFailureReason || poll.message || poll.error || "자동매매를 시작하지 못했습니다.",
    409,
    {
      ...poll,
      errorCode: "PAPER_PREFLIGHT_BLOCKED",
      message: poll.message,
    },
  );
}

export function useTrading(initialState: PublicState) {
  const [state, setState] = useState<PublicState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const tickAllowedRef = useRef(initialState.runtime?.httpTickAllowed !== false);
  const visibleRef = useRef(true);

  const load = useCallback(async (mode: "full" | "dashboard" | "tick" = "full") => {
    try {
      if (mode === "tick" && tickAllowedRef.current) {
        const next = await api<PublicState>("/api/tick", { method: "POST" });
        if (next.runtime) tickAllowedRef.current = next.runtime.httpTickAllowed !== false;
        setState(next);
        setError(null);
        return;
      }
      // Auto-refresh uses slim dashboard view — full book stays on /api/state.
      const path = mode === "dashboard" ? "/api/state?view=dashboard" : "/api/state";
      const next = await api<PublicState>(path);
      if (next.runtime) {
        tickAllowedRef.current = next.runtime.httpTickAllowed !== false;
      }
      setState((prev) => {
        // Preserve tab-local arrays when a slim dashboard poll returns empties.
        if (mode === "dashboard") {
          return {
            ...next,
            orders: next.orders?.length ? next.orders : prev.orders,
            intents: next.intents?.length ? next.intents : prev.intents,
            conditions: next.conditions?.length ? next.conditions : prev.conditions,
            dcaPlans: next.dcaPlans?.length ? next.dcaPlans : prev.dcaPlans,
          };
        }
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "시세를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === "visible";
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    let polling = false;
    // Dashboard refresh: read-only summary. Do not POST /api/tick every few seconds —
    // workers own ticks; HTTP ticks amplify queue + DB contention across tabs.
    const id = window.setInterval(() => {
      if (polling || !visibleRef.current) return;
      polling = true;
      void load("dashboard").finally(() => {
        polling = false;
      });
    }, 5_000);
    return () => window.clearInterval(id);
  }, [load]);

  return { state, setState, error, reload: load };
}
