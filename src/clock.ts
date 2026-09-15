let override: number | null = null;

export function nowMs(): number {
  return override ?? Date.now();
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

export function setNowMs(value: number | null) {
  override = value;
}

export async function withNow<T>(value: number, fn: () => Promise<T> | T): Promise<T> {
  const prev = override;
  override = value;
  try {
    return await fn();
  } finally {
    override = prev;
  }
}
