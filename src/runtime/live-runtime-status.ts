/**
 * Read-only helpers for PAPER runtime health scripts.
 * Prefer live server endpoints over local-process status inference.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabasePublicStatus } from "@/src/db/status";

export type { DatabasePublicStatus };

/** RDS PASS: mirror + enabled + connected + no DB_MIRROR_DEGRADED. Missing status ⇒ fail. */
export function isLiveRdsHealthy(
  db: DatabasePublicStatus | null | undefined,
): boolean {
  if (db == null) return false;
  if (db.mode !== "mirror") return false;
  if (db.enabled !== true) return false;
  if (db.connected !== true) return false;
  if (String(db.lastError ?? "").includes("DB_MIRROR_DEGRADED")) return false;
  return true;
}

export function isMirrorDegraded(
  db: DatabasePublicStatus | null | undefined,
): boolean {
  return Boolean(String(db?.lastError ?? "").includes("DB_MIRROR_DEGRADED"));
}

/**
 * Fetch authoritative DB status from the running server (uses pingDb).
 * Returns null on network/HTTP failure — callers must treat as UNKNOWN/FAIL.
 * Never silently falls back to local publicDatabaseStatus for PASS.
 */
export async function fetchLiveDatabaseStatus(
  baseUrl: string,
): Promise<DatabasePublicStatus | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/runtime/database`);
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DatabasePublicStatus>;
    if (body == null || typeof body !== "object") return null;
    return {
      enabled: Boolean(body.enabled),
      connected: Boolean(body.connected),
      mode: body.mode === "mirror" || body.mode === "json" ? body.mode : "json",
      lastMirrorAt: body.lastMirrorAt ?? null,
      lastError: body.lastError ?? null,
    };
  } catch {
    return null;
  }
}

export type PersistenceHealthResult = {
  healthy: boolean;
  stateApiOk: boolean;
  fileReadable: boolean;
  reason: string;
};

/**
 * Persistence health without writing production state.
 * HEALTHY requires live /api/state success AND production JSON readable/parseable.
 */
export async function measurePersistenceHealth(
  baseUrl: string,
  accountPath: string = path.join(process.cwd(), "data", "paper-account.json"),
): Promise<PersistenceHealthResult> {
  let stateApiOk = false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/state`);
    stateApiOk = res.ok;
  } catch {
    stateApiOk = false;
  }

  let fileReadable = false;
  try {
    if (existsSync(accountPath)) {
      JSON.parse(readFileSync(accountPath, "utf8"));
      fileReadable = true;
    }
  } catch {
    fileReadable = false;
  }

  if (stateApiOk && fileReadable) {
    return {
      healthy: true,
      stateApiOk,
      fileReadable,
      reason: "api_state_ok+json_readable",
    };
  }
  if (!fileReadable && !existsSync(accountPath)) {
    return {
      healthy: false,
      stateApiOk,
      fileReadable,
      reason: "paper_account_missing",
    };
  }
  if (!fileReadable) {
    return {
      healthy: false,
      stateApiOk,
      fileReadable,
      reason: "paper_account_unreadable",
    };
  }
  return {
    healthy: false,
    stateApiOk,
    fileReadable,
    reason: "api_state_unavailable",
  };
}
