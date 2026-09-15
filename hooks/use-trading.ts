"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicState } from "@/lib/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
  let data: T & { error?: string };
  try {
    data = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new ApiError("서버가 JSON이 아닌 응답을 보냈습니다.", res.status || 500);
  }
  if (!res.ok) {
    throw new ApiError(data.error ?? "요청에 실패했습니다.", res.status);
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
