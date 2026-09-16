import { publicDatabaseStatus } from "@/src/db/mirror";
import { pingDb } from "@/src/db/client";
import { persistenceMode, dbConfigured } from "@/src/db/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const mode = persistenceMode();
  const configured = dbConfigured();
  const connected = mode === "mirror" && configured ? await pingDb() : false;
  const status = publicDatabaseStatus();
  return Response.json({
    enabled: status.enabled,
    connected,
    mode: status.mode,
    lastMirrorAt: status.lastMirrorAt,
    lastError: status.lastError,
  });
}
