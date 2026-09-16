export type DatabasePublicStatus = {
  enabled: boolean;
  connected: boolean;
  mode: "json" | "mirror";
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
  mode: "json" | "mirror";
  connected?: boolean;
}): DatabasePublicStatus {
  return {
    enabled: input.enabled,
    connected: input.connected ?? lastConnected,
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
