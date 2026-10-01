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
    });
  }
  return data;
}

export function useTrading(initialState: PublicState) {
  const [state, setState] = useState<PublicState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const tickAllowedRef = useRef(initialState.runtime?.httpTickAllowed !== false);

  const load = useCallback(async (tick = false) => {
    try {
      const allowTick = tick && tickAllowedRef.current;
      const next = allowTick
        ? await api<PublicState>("/api/tick", { method: "POST" })
        : await api<PublicState>("/api/state");
      if (next.runtime) {
        tickAllowedRef.current = next.runtime.httpTickAllowed !== false;
      }
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "시세를 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load(true);
    }, 2500);
    return () => window.clearInterval(id);
  }, [load]);

  return { state, setState, error, reload: load };
}
