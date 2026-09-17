import { loadLocalEnv } from "@/src/db/load-env";

loadLocalEnv();
process.env.PERSISTENCE_MODE ??= "mirror";
process.env.TRADING_MODE ??= "live_test";
process.env.KIS_MODE ??= "demo";
process.env.BROKER ??= "kis";
if (process.env.ALLOW_LIVE_TRADING === "true") {
  throw new Error("Refuse: ALLOW_LIVE_TRADING must stay false");
}
delete process.env.KIS_LIVE_CONFIRM;
delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
delete process.env.RUN_KIS_VTS_ORDER_TESTS;

import { KisClient } from "@/src/brokers/kis-client";
import { persistenceMode } from "@/src/db/config";
import { publicDatabaseStatus, resolveMirrorLedger } from "@/src/db/mirror";
import { mutateStore } from "@/lib/store";
import { getRuleConfig } from "@/src/rules/config";
import {
  domesticPaperControlledEnv,
  emptyControlledRun,
  existingPositionLines,
  formatSoakReport,
  formatStartSummary,
  reconStatusOf,
  selectConservativeStrategy,
} from "@/src/runtime/controlled-run";
import { engineReconciliationFlag } from "@/src/risk/kis-balance-semantics";
import { refreshBrokerBalanceSnapshot } from "@/src/risk/balance-sync";

const TICKER = "005930";

async function pingRds(): Promise<{ ok: boolean; message: string }> {
  if (persistenceMode() !== "mirror") return { ok: false, message: "PERSISTENCE_MODE is not mirror" };
  const ledger = await resolveMirrorLedger();
  if (!ledger) return { ok: false, message: "RDS ledger missing" };
  try {
    await ledger.transaction(async (tx) => {
      await tx.listBrokerAccounts();
    });
    return { ok: true, message: "CONNECTED" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "RDS ping failed" };
  }
}

async function main() {
  const envBlock = domesticPaperControlledEnv();
  const rds = await pingRds();
  const client = KisClient.fromEnv();
  const configOk = client.configured && client.mode === "paper" && client.liveEnabled;
  let quoteOk = false;
  let positionOk = false;
  let qty = 0;
  let recon = "UNKNOWN";
  let readyReason = envBlock ?? (!rds.ok ? rds.message : !configOk ? "KIS PAPER client not ready" : undefined);

  const state = await mutateStore(async (current) => current);
  const strategy = selectConservativeStrategy(getRuleConfig().rules, state.positions);
  if (strategy.enabledCount > 1) {
    readyReason = readyReason ?? "multiple strategies enabled; selection must be applied before start";
  }

  if (!readyReason && client.configured) {
    try {
      const quote = await client.inquirePrice(TICKER);
      quoteOk = quote.price > 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const box = { current: structuredClone(state) };
      const synced = await refreshBrokerBalanceSnapshot(box, client);
      const samsung = box.current.kisBalance?.holdings.find((row) => row.ticker === TICKER);
      qty = samsung?.qty ?? 0;
      positionOk = qty === 1;
      recon = engineReconciliationFlag(box.current) === "synced" ? "HEALTHY" : reconStatusOf(box.current);
      if (!synced.ok) readyReason = synced.error ?? "broker balance unhealthy";
      else if (!quoteOk) readyReason = "KIS quote failed";
      else if (!positionOk) readyReason = `existing 005930 qty is ${qty}, expected 1`;
      else if (recon === "MISMATCH") readyReason = "Reconciliation MISMATCH";
    } catch (err) {
      readyReason = err instanceof Error ? err.message : "KIS preflight failed";
    }
  }

  const ready = !readyReason;
  const summary = formatStartSummary({
    ready,
    readyReason,
    strategy,
    positions: existingPositionLines(state),
    recon,
    rds: rds.ok ? "CONNECTED" : rds.message,
  });
  console.log(summary);
  console.log("");
  console.log("Strategy selection reason:");
  console.log(strategy.reason);
  console.log("");
  console.log(`Quote healthy: ${quoteOk}`);
  console.log(`Existing 005930 qty: ${qty}`);
  console.log(`RDS: ${rds.message}`);
  console.log(`db status: ${JSON.stringify({ ...publicDatabaseStatus(), lastError: publicDatabaseStatus().lastError })}`);

  if (!ready) {
    console.log("\nReady=NO — worker soak not armed.");
    process.exitCode = 2;
    return;
  }

  const armed = await mutateStore((current) => ({
    ...current,
    settings: { ...current.settings, autoTrading: true },
    controlledRun:
      current.controlledRun?.status === "running" || current.controlledRun?.status === "paused"
        ? current.controlledRun
        : emptyControlledRun({
            strategyName: strategy.strategy,
            symbols: strategy.symbols.length ? strategy.symbols : [TICKER],
          }),
  }));
  console.log("\nControlled run armed. Existing worker/engine ticks will evaluate live KIS quotes.");
  console.log(`startedAt=${armed.controlledRun?.startedAt}`);
  console.log("No forced signals. 0 trades is a valid result.");
}

const reportOnly = process.argv.includes("--report");
if (reportOnly) {
  mutateStore((state) => state)
    .then((state) => {
      console.log(formatSoakReport(state));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
