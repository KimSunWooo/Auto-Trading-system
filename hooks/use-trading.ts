"use client";

import { useCallback, useEffect, useState } from "react";
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
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(data.error ?? "요청에 실패했습니다.", res.status);
  }
  return data;
}

export function useTrading(initialState: PublicState) {
  const [state, setState] = useState<PublicState>(initialState);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tick = false) => {
    try {
      const next = tick
        ? await api<PublicState>("/api/tick", { method: "POST" })
        : await api<PublicState>("/api/state");
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
