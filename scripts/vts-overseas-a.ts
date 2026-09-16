/**
 * Overseas VTS-A read-only harness. Loads .env.local in-process.
 * Does not write order opt-in. Does not place PAPER or REAL orders.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KisClient } from "@/src/brokers/kis-client";
import { KIS_HOSTS, loadKisConfig } from "@/src/brokers/kis-config";
import { makeUsInstrument } from "@/src/markets/overseas/instruments";
import { findOpenOrderByOdno } from "@/src/markets/overseas/mapping";
import { KIS_CURRENCY_EXCHANGE_AUDIT } from "@/src/markets/overseas/exchange-audit";
import {
  appendVtsEvent,
  assertVtsSafeEnv,
  beginVtsTestRun,
  finishVtsTestRun,
  writeVtsReconciliation,
} from "@/src/runtime/vts-harness";

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

type Step = { name: string; status: "PASS" | "FAIL"; detail?: string };

async function main() {
  loadDotEnvLocal();
  process.env.RUN_KIS_VTS_OVERSEAS_TESTS = "true";
  delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
  delete process.env.RUN_KIS_VTS_ORDER_TESTS;
  delete process.env.VTS_TEST_SYMBOL;
  delete process.env.VTS_OVERSEAS_TEST_SYMBOL;

  assertVtsSafeEnv();
  const cfg = loadKisConfig();
  if (cfg.environment !== "paper") {
    throw new Error("Overseas VTS-A aborted: KIS_MODE is not paper/demo");
  }
  if (!cfg.configured) {
    throw new Error("Overseas VTS-A aborted: PAPER credentials are not configured");
  }

  let paperOrderPosts = 0;
  let realRequests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(KIS_HOSTS.real)) realRequests += 1;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && /\/trading\/order/.test(url)) {
      paperOrderPosts += 1;
      throw new Error("Overseas VTS-A safety: order POST blocked");
    }
    return globalThis.fetch(input, init);
  };

  const client = new KisClient(cfg, fetchImpl);
  const run = beginVtsTestRun("OVTS-A", { market: "overseas" });
  const steps: Step[] = [];
  const instrument = makeUsInstrument("NASDAQ", "AAPL");

  async function step(name: string, fn: () => Promise<string | void>) {
    try {
      const detail = (await fn()) ?? "";
      steps.push({ name, status: "PASS", detail });
      appendVtsEvent(run.dir, { kind: "step", name, status: "PASS", detail });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ name, status: "FAIL", detail });
      appendVtsEvent(run.dir, { kind: "step", name, status: "FAIL", detail });
    }
  }

  await step("Authentication", async () => {
    const quote = await client.inquireOverseasPrice(instrument);
    if (quote.price <= 0) throw new Error("quote after token was empty");
    return `token+quote ${quote.identity} ${quote.currency}`;
  });
  await step("Quote", async () => {
    const quote = await client.inquireOverseasPrice(instrument);
    if (quote.source !== "kis" || quote.price <= 0) throw new Error("quote missing");
    return `${quote.identity} last=${quote.price} ${quote.currency}`;
  });
  let usdCash = 0;
  await step("Foreign Cash", async () => {
    const present = await client.inquireOverseasPresentBalance();
    const usd = present.cash.find((row) => row.currency === "USD");
    usdCash = usd?.cash ?? 0;
    return `USD cash=${usd?.cash ?? "n/a"} orderable=${usd?.orderableCash ?? "n/a"} fx=${present.fx?.rate ?? "n/a"}`;
  });
  await step("Balance", async () => {
    const present = await client.inquireOverseasPresentBalance();
    return `cash rows=${present.cash.length} krwEquivalent=${present.estimatedKrwValue ?? "n/a"}`;
  });
  await step("Positions", async () => {
    const { positions } = await client.inquireOverseasBalance("NASDAQ");
    return `count=${positions.length}`;
  });
  await step("Open Orders", async () => {
    const open = await client.inquireOverseasOpenOrders("NASDAQ");
    for (const row of open) {
      if (findOpenOrderByOdno(open, row.orderNo)?.orderNo !== row.orderNo) {
        throw new Error("ODNO exact match failed");
      }
    }
    return `count=${open.length}`;
  });
  await step("Executions", async () => {
    const execs = await client.inquireOverseasExecutions();
    return `count=${execs.length}`;
  });
  await step("Reconciliation", async () => {
    const present = await client.inquireOverseasPresentBalance();
    const { positions } = await client.inquireOverseasBalance("NASDAQ");
    writeVtsReconciliation(run.dir, {
      market: "overseas",
      usdCash,
      positions: positions.map((row) => ({ identity: row.identity, qty: row.qty, currency: row.currency })),
      presentPositions: present.positions.map((row) => ({ identity: row.identity, qty: row.qty })),
      fx: present.fx,
    });
    return "wrote reconciliation.json";
  });

  const failed = steps.some((row) => row.status === "FAIL");
  const summary = {
    market: "overseas",
    steps,
    paperOverseasOrders: paperOrderPosts,
    realRequests,
    exchangeAudit: KIS_CURRENCY_EXCHANGE_AUDIT,
    outcome: failed || paperOrderPosts > 0 || realRequests > 0 ? "FAIL" : "PASS",
  };
  writeFileSync(path.join(run.dir, "overseas-vts-a.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  finishVtsTestRun(run, summary.outcome === "PASS" ? "PASS" : "FAIL", summary);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.outcome !== "PASS") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
