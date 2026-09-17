import { existsSync } from "node:fs";
import path from "node:path";
import { withStore } from "@/lib/store";
import { getBrokerPublicStatus } from "@/src/brokers/kis-config";
import { dbConfigured, persistenceMode } from "@/src/db/config";
import { publicDatabaseStatus } from "@/src/db/mirror";
import { safetyOf } from "@/src/runtime/safety";
import { allowLiveTrading, tradingMode } from "@/src/runtime/trading-mode";
import { workerLockHealthy } from "@/src/runtime/worker-lock";

export const dynamic = "force-dynamic";

/**
 * Ready for PAPER soak. Uses cached runtime / lock heartbeat.
 * Does not call KIS on each probe.
 */
export async function GET() {
  const mode = tradingMode();
  const persist = persistenceMode();
  const broker = getBrokerPublicStatus();
  const db = publicDatabaseStatus();
  const dataDir = path.join(process.cwd(), "data");
  const jsonReadable = existsSync(dataDir);

  let safetyKind = "ok";
  let emergency = false;
  let storeCorrupt = false;
  try {
    await withStore((state) => {
      const safety = safetyOf(state);
      safetyKind = safety.kind;
      emergency = safety.kind === "emergency_stop";
      storeCorrupt = safety.kind === "store_corrupt";
      return state;
    });
  } catch {
    storeCorrupt = true;
    safetyKind = "store_corrupt";
  }

  const workerOk = !["live_test", "live"].includes(mode) || workerLockHealthy();
  const rdsOk =
    persist !== "mirror" || (dbConfigured() && db.enabled && !db.lastError);
  const realLocked = mode !== "live" && !allowLiveTrading();
  const ready =
    jsonReadable && workerOk && realLocked && !emergency && !storeCorrupt && (persist !== "mirror" || rdsOk);

  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      ready,
      checks: {
        jsonReadable,
        workerHeartbeat: workerOk,
        persistenceMode: persist,
        rds: persist === "mirror" ? (rdsOk ? "ok" : "degraded") : "n/a",
        brokerDriver: broker.driver,
        brokerConfigured: broker.configured,
        tradingMode: mode,
        realLocked,
        safetyKind,
      },
    },
    { status: ready ? 200 : 503 },
  );
}
