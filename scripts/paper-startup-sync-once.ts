/**
 * Restore problem order local id from RDS identity, then run PAPER Startup Sync
 * through mutateStore (coordinates with live Next worker). Inquiries only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mutateStore } from "@/lib/store";
import { getSharedKisClient } from "@/src/brokers/kis-client";
import {
  emptyStartupSync,
  runPaperStartupSync,
  usesPaperStartupSync,
} from "@/src/runtime/startup-sync";

const PROBLEM_ID = "88e68d0a-edea-4443-9cc0-3d19a54b6e08";
const PROBLEM_ODNO = "0000000101";
const PROBLEM_INTENT = "sig:paper:dup";

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  loadDotEnvLocal();
  if (!usesPaperStartupSync()) {
    console.error("usesPaperStartupSync=false");
    process.exit(1);
  }

  // Restore local_order_id identity without deleting rows.
  await mutateStore((state) => {
    const orders = state.orders.map((order) => {
      if (order.id === PROBLEM_ID) return order;
      const sameLogical =
        order.brokerOrderNo === PROBLEM_ODNO &&
        order.intentId === PROBLEM_INTENT &&
        order.createdAt.startsWith("2026-09-15");
      if (!sameLogical) return order;
      console.log(`restoring local order id ${order.id} → ${PROBLEM_ID}`);
      return { ...order, id: PROBLEM_ID };
    });
    const intents = (state.intents ?? []).map((intent) =>
      intent.intentId === PROBLEM_INTENT && intent.orderId && intent.orderId !== PROBLEM_ID
        ? { ...intent, orderId: PROBLEM_ID }
        : intent,
    );
    return { ...state, orders, intents };
  });

  // Cool down KIS rate limit from prior Next worker traffic.
  await sleep(90_000);

  const client = getSharedKisClient();
  let attempt = 0;
  let lastError = "";
  while (attempt < 5) {
    attempt += 1;
    const result = await mutateStore(async (state) => {
      const marked = {
        ...state,
        startupSync: {
          ...(state.startupSync ?? emptyStartupSync()),
          status: "SYNCING" as const,
          message: `one-shot startup sync attempt ${attempt}`,
        },
      };
      return (await runPaperStartupSync(marked, client)).state;
    });

    const problem = result.orders.find((o) => o.id === PROBLEM_ID);
    console.log("attempt", attempt, {
      startup: result.startupSync,
      problem: problem
        ? {
            id: problem.id,
            activeClass: problem.activeClass,
            provenance: problem.provenance,
            status: problem.status,
            reason: problem.reason,
          }
        : null,
      positions: result.positions.map((p) => `${p.code}=${p.qty}`),
      kisHoldings: (result.kisBalance?.holdings ?? []).map(
        (h) => `${h.ticker}=${h.qty}@${h.avgPrice}`,
      ),
      orderCount: result.orders.length,
    });

    if (result.startupSync?.status === "HEALTHY") {
      console.log("Startup Sync HEALTHY");
      process.exit(0);
    }
    lastError = result.startupSync?.message ?? "FAILED";
    if (/초당|EGW00201|rate/i.test(lastError)) {
      await sleep(20_000 * attempt);
      continue;
    }
    break;
  }
  console.error("Startup Sync ended with:", lastError);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
