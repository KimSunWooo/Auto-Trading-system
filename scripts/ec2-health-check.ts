#!/usr/bin/env tsx
/**
 * Local / EC2 PAPER health probe. No KIS order calls. No secrets printed.
 */
import { loadLocalEnv } from "@/src/db/load-env";

loadLocalEnv();

const base = process.env.HEALTH_BASE_URL?.trim() || "http://127.0.0.1:43147";

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const live = await get("/api/health/live");
  const ready = await get("/api/health/ready");
  const db = await get("/api/runtime/database");
  console.log(
    JSON.stringify(
      {
        base,
        live,
        ready,
        database: {
          ok: db.ok,
          status: db.status,
          body:
            db.body && typeof db.body === "object"
              ? {
                  enabled: (db.body as { enabled?: boolean }).enabled,
                  connected: (db.body as { connected?: boolean }).connected,
                  mode: (db.body as { mode?: string }).mode,
                  lastMirrorAt: (db.body as { lastMirrorAt?: string | null }).lastMirrorAt,
                  lastError: (db.body as { lastError?: string | null }).lastError,
                }
              : db.body,
        },
      },
      null,
      2,
    ),
  );
  if (!live.ok || !ready.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
