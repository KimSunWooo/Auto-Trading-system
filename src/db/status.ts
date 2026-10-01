export type DatabasePublicStatus = {
  enabled: boolean;
  connected: boolean;
  mode: "json" | "mirror" | "database";
  lastMirrorAt: string | null;
  lastError: string | null;
};

let lastMirrorAt: string | null = null;
let lastError: string | null = null;
let lastConnected = false;

export function recordMirrorSuccess(): void {
  lastMirrorAt = new Date().toISOString();
  lastError = null;
  lastConnected = true;
}

export function recordMirrorFailure(reason: string): void {
  lastError = reason.slice(0, 500);
  lastConnected = false;
}

export function recordMirrorDegraded(reason: string): void {
  lastError = `DB_MIRROR_DEGRADED: ${reason}`.slice(0, 500);
}

export function snapshotDatabaseStatus(input: {
  enabled: boolean;
  mode: "json" | "mirror" | "database";
  connected?: boolean;
}): DatabasePublicStatus {
  const inferred =
    input.connected ??
    (input.enabled &&
    (input.mode === "mirror" || input.mode === "database") &&
    lastError == null
      ? true
      : lastConnected);
  return {
    enabled: input.enabled,
    connected: inferred,
    mode: input.mode,
    lastMirrorAt,
    lastError,
  };
}

export function resetDatabaseStatusForTest(): void {
  lastMirrorAt = null;
  lastError = null;
  lastConnected = false;
}
