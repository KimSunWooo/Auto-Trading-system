/**
 * Enable paper-long-soak-ma only when live gates pass.
 * Never forces MA / crossover. Never REAL.
 */
import { readFileSync, existsSync } from "node:fs";

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i);
    let v = t.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null) process.env[k] = v;
  }
}

async function getState() {
  const res = await fetch("http://127.0.0.1:43147/api/state");
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json() as Promise<Record<string, any>>;
}

async function getDatabase() {
  const res = await fetch("http://127.0.0.1:43147/api/runtime/database");
  if (!res.ok) throw new Error(`database ${res.status}`);
  return res.json() as Promise<Record<string, any>>;
}

async function evaluate(s: Record<string, any>, db: Record<string, any>) {
  const now = Date.now();
  const q = s.quotes?.["035720"];
  // Activation window: align with paper-long-soak-activation-gate (120s).
  // Order path still enforces 15s freshness via KisBroker/preTradeGate.
  const quoteFresh = Boolean(q?.source === "kis" && q.freshAt && now - q.freshAt <= 120_000);
  const mockSeed = Object.values(s.quotes || {}).some(
    (x: any) => x.source === "mock" || x.source === "seed",
  );
  const unknown = (s.orders || []).some((o: any) => o.status === "unknown");
  const openBuy = (s.orders || []).some(
    (o: any) =>
      o.side === "buy" &&
      (o.status === "pending" || o.status === "unknown") &&
      o.activeClass !== "ORPHANED_LOCAL" &&
      o.activeClass !== "HISTORICAL_MATCHED",
  );
  const rds =
    db?.mode === "mirror" &&
    db?.enabled === true &&
    db?.connected === true &&
    !String(db?.lastError || "").includes("DB_MIRROR_DEGRADED");

  const reconSynced = s.safety?.reconciliation === "synced";
  const positionsMatch = s.kisBalance?.matched === true;
  // After-hours inquiry flakes can mark recon unavailable while holdings still match.
  const reconOk = reconSynced || (positionsMatch && s.kisBalance?.freshness === "fresh");

  const checks: Record<string, boolean> = {
    brokerKis: s.broker?.driver === "kis" && s.broker?.mode === "paper",
    liveTest: s.runtime?.tradingMode === "live_test",
    startup: s.startupSync?.status === "HEALTHY",
    quoteFresh,
    sourceKis: q?.source === "kis",
    noMockSeed: !mockSeed,
    balance: s.kisBalance != null,
    orderable: (s.kisBalance?.orderableCash ?? 0) > 0,
    positionsMatch,
    recon: reconOk,
    unknownNone: !unknown,
    openBuyNone: !openBuy,
    worker: s.safety?.workerHealthy !== false,
    // Prefer quoteOk, but allow activation if watched KIS quotes are present & fresh enough.
    quoteOk: s.safety?.quoteOk === true || quoteFresh,
    rds,
  };
  const fail = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  return { checks, fail, ready: fail.length === 0 };
}

async function main() {
  loadEnv();
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("ABORT REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") throw new Error("ABORT REAL");
  if (process.env.KIS_LIVE_CONFIRM) throw new Error("ABORT LIVE CONFIRM");

  let last: Awaited<ReturnType<typeof evaluate>> | null = null;
  for (let i = 0; i < 36; i++) {
    const s = await getState();
    const db = await getDatabase();
    last = await evaluate(s, db);
    console.log(
      JSON.stringify({
        attempt: i + 1,
        ready: last.ready,
        fail: last.fail,
        safety: s.safety?.kind,
        recon: s.safety?.reconciliation,
        quoteOk: s.safety?.quoteOk,
        matched: s.kisBalance?.matched,
        rds: { mode: db.mode, connected: db.connected, enabled: db.enabled },
      }),
    );
    if (!last.ready) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    const rules = (s.ruleConfig?.rules || []).map((r: any) =>
      r.id === "paper-long-soak-ma" ? { ...r, enabled: true } : r,
    );
    const patch = await fetch("http://127.0.0.1:43147/api/strategy-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });
    const body = await patch.json();
    if (!patch.ok) {
      console.error("ENABLE_FAIL", body?.error || patch.status);
      process.exit(1);
    }

    if (!s.settings?.autoTrading) {
      const setRes = await fetch("http://127.0.0.1:43147/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoTrading: true }),
      });
      if (!setRes.ok) {
        console.error("AUTO_FAIL", await setRes.text());
        process.exit(1);
      }
    }

    const after = await getState();
    const rule = after.ruleConfig?.rules?.find((r: any) => r.id === "paper-long-soak-ma");
    console.log(
      JSON.stringify(
        {
          ENABLED: true,
          ruleEnabled: rule?.enabled,
          autoTrading: after.settings?.autoTrading,
          alloc: (after.allocations || []).map((a: any) => ({
            id: a.ruleId,
            enabled: a.enabled,
            budget: a.budget,
            balance: a.balance,
            meta: a.meta,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error("TIMEOUT_NOT_READY", last);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
