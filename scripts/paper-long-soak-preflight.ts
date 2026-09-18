/**
 * Read-only KIS PAPER preflight + Long Soak candidate audit.
 * Never places orders. Never enables REAL.
 *
 * Usage: npx tsx scripts/paper-long-soak-preflight.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { KisClient } from "@/src/brokers/kis-client";
import { findStock } from "@/lib/universe";
import { sma } from "@/src/strategies/indicators";

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

const CANDIDATES = ["035720", "105560", "055550", "000270", "005930", "069500"];

async function main() {
  loadDotEnvLocal();
  if (process.env.ALLOW_LIVE_TRADING === "true") throw new Error("Refuse REAL");
  if (String(process.env.KIS_MODE ?? "").toLowerCase() === "real") throw new Error("Refuse REAL mode");
  delete process.env.KIS_LIVE_CONFIRM;

  const client = KisClient.fromEnv();
  console.log("=== KIS PAPER Read-Only Preflight ===");
  console.log("configured", client.configured, "mode", client.mode, "liveEnabled", client.liveEnabled);

  if (!client.configured || client.mode !== "paper") {
    console.error("KIS PAPER client not ready");
    process.exit(1);
  }

  let orderPosts = 0;
  const steps: Array<{ name: string; status: string; detail?: string }> = [];

  try {
    // Auth implied by first successful call
    const balance = await client.inquireBalance();
    steps.push({
      name: "Auth/Balance",
      status: "PASS",
      detail: `cash=${balance.cash} d2=${balance.d2Cash} holdings=${balance.holdings.length}`,
    });

    let orderable: number | undefined;
    try {
      const psbl = await client.inquirePsblOrder?.({ ticker: "005930", price: 70_000 });
      orderable = psbl?.orderableCash;
      steps.push({ name: "Orderable", status: "PASS", detail: String(orderable) });
    } catch (err) {
      steps.push({
        name: "Orderable",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const open = await client.inquireOpenOrders();
    steps.push({ name: "Open Orders", status: "PASS", detail: `count=${open.length}` });

    const fills = await client.inquireDailyCcld();
    steps.push({ name: "Executions", status: "PASS", detail: `count=${fills.length}` });

    console.log("\nHoldings:");
    for (const h of balance.holdings) {
      console.log(`  ${h.ticker} qty=${h.qty} avg=${h.avgPrice}`);
    }

    const held = new Set(balance.holdings.filter((h) => h.qty > 0).map((h) => h.ticker.replace(/\D/g, "").slice(-6).padStart(6, "0")));
    const accountValue =
      balance.cash +
      balance.holdings.reduce((sum, h) => sum + h.qty * (h.avgPrice || 0), 0);

    console.log("\n=== Candidates ===");
    const rows: Array<Record<string, unknown>> = [];
    for (const ticker of CANDIDATES) {
      try {
        const quote = await client.inquirePrice(ticker);
        const closes = await client.inquireDailyCloses(ticker);
        const history = [...closes, quote.price].filter((n) => n > 0);
        const fast = sma(history, 5);
        const slow = sma(history, 20);
        const notional5 = quote.price * 5;
        const weight = notional5 / Math.max(1, accountValue);
        const stock = findStock(ticker);
        const row = {
          ticker,
          name: stock?.name ?? quote.name,
          price: quote.price,
          held: held.has(ticker) ? 1 : 0,
          notional5,
          weightPct: Math.round(weight * 1000) / 10,
          historyLen: history.length,
          fast,
          slow,
          trend: fast != null && slow != null ? (fast > slow ? "above" : fast < slow ? "below" : "flat") : "warmup",
          openOrders: open.filter((o) => o.ticker.replace(/\D/g, "").includes(ticker.replace(/^0+/, ""))).length,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
        // brief pause to reduce rate limit
        await new Promise((r) => setTimeout(r, 350));
      } catch (err) {
        console.log(JSON.stringify({ ticker, error: err instanceof Error ? err.message : String(err) }));
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    console.log("\n=== Steps ===");
    for (const s of steps) console.log(`${s.status} ${s.name} ${s.detail ?? ""}`);
    console.log("Broker order HTTP POST:", orderPosts);
    console.log("AccountValueApprox:", accountValue);
    console.log("Orderable:", orderable ?? null);

    // Prefer non-held, history>=20, weight<=10%, price allows qty under slice 300k
    const ranked = rows
      .filter((r) => typeof r.price === "number" && (r.historyLen as number) >= 20)
      .filter((r) => (r.weightPct as number) <= 15)
      .sort((a, b) => {
        const ah = a.held as number;
        const bh = b.held as number;
        if (ah !== bh) return ah - bh;
        return (a.weightPct as number) - (b.weightPct as number);
      });
    console.log("\nSelectedCandidate:", ranked[0] ?? null);
  } finally {
    // no orderCash called
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
