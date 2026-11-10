import { publicDatabaseStatus } from "@/src/db/mirror";
import { pingDb } from "@/src/db/client";
import { persistenceMode, dbConfigured } from "@/src/db/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const mode = persistenceMode();
  const configured = dbConfigured();
  const connected =
    configured && (mode === "mirror" || mode === "database") ? await pingDb() : false;
  const status = publicDatabaseStatus();
  return Response.json({
    enabled: status.enabled,
    connected,
    mode: status.mode,
    /** Effective process env after compose/.env resolution — verify ops did not get overwritten. */
    persistenceMode: mode,
    dbConfigured: configured,
    lastMirrorAt: status.lastMirrorAt,
    lastError: status.lastError,
  });
}
