export type DatabasePublicStatus = {
  enabled: boolean;
  connected: boolean;
  mode: "json" | "mirror" | "database";
  lastMirrorAt: string | null;
  lastError: string | null;
};

type StatusGlobal = typeof globalThis & {
  __miraeDbStatus?: {
    lastMirrorAt: string | null;
    lastError: string | null;
    lastConnected: boolean;
  };
};

function slot() {
  const g = globalThis as StatusGlobal;
  g.__miraeDbStatus ??= {
    lastMirrorAt: null,
    lastError: null,
    lastConnected: false,
  };
  return g.__miraeDbStatus;
}

export function recordMirrorSuccess(): void {
  const s = slot();
  s.lastMirrorAt = new Date().toISOString();
  s.lastError = null;
  s.lastConnected = true;
}

export function recordMirrorFailure(reason: string): void {
  const s = slot();
  s.lastError = reason.slice(0, 500);
  s.lastConnected = false;
}

export function recordMirrorDegraded(reason: string): void {
  const s = slot();
  s.lastError = `DB_MIRROR_DEGRADED: ${reason}`.slice(0, 500);
}

export function snapshotDatabaseStatus(input: {
  enabled: boolean;
  mode: "json" | "mirror" | "database";
  connected?: boolean;
}): DatabasePublicStatus {
  const s = slot();
  const inferred =
    input.connected ??
    (input.enabled &&
    (input.mode === "mirror" || input.mode === "database") &&
    s.lastError == null
      ? true
      : s.lastConnected);
  return {
    enabled: input.enabled,
    connected: inferred,
    mode: input.mode,
    lastMirrorAt: s.lastMirrorAt,
    lastError: s.lastError,
  };
}

export function resetDatabaseStatusForTest(): void {
  const s = slot();
  s.lastMirrorAt = null;
  s.lastError = null;
  s.lastConnected = false;
}
