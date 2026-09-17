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
import { closeDb } from "@/src/db/client";
import { mutateStore } from "@/lib/store";
import { getRuleConfig } from "@/src/rules/config";
import {
  domesticPaperControlledEnv,
  emptyControlledRun,
  existingPositionLines,
  formatSoakReport,
  formatStartSummary,
  isTransientInquirySoakStop,
  reconStatusOf,
  resumeTransientUnknownStop,
  selectConservativeStrategy,
} from "@/src/runtime/controlled-run";
import {
  brokerSnapshotFreshness,
  engineReconciliationFlag,
} from "@/src/risk/kis-balance-semantics";
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
  if (
    state.controlledRun?.status === "stopped" &&
    !isTransientInquirySoakStop(state)
  ) {
    readyReason =
      readyReason ?? state.controlledRun.autoStopReason ?? "AUTO TRADING STOP";
  }

  if (!readyReason && client.configured) {
    try {
      const existingSnap = state.kisBalance;
      const freshExisting =
        brokerSnapshotFreshness(state, existingSnap) === "fresh" && existingSnap?.matched === true;
      if (freshExisting) {
        quoteOk = state.quotes[TICKER]?.source === "kis" && (state.quotes[TICKER]?.price ?? 0) > 0;
        qty = existingSnap?.holdings.find((row) => row.ticker === TICKER)?.qty ?? 0;
        positionOk = qty === 1;
        recon = engineReconciliationFlag(state) === "synced" ? "HEALTHY" : reconStatusOf(state);
        if (!quoteOk) {
          const quote = await client.inquirePrice(TICKER);
          quoteOk = quote.price > 0;
        }
        if (!quoteOk) readyReason = "KIS quote failed";
        else if (!positionOk) readyReason = `existing 005930 qty is ${qty}, expected 1`;
        else if (recon === "MISMATCH") readyReason = "Reconciliation MISMATCH";
      } else {
        const quote = await client.inquirePrice(TICKER);
        quoteOk = quote.price > 0;
        await new Promise((resolve) => setTimeout(resolve, 1500));
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
      }
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
    await closeDb();
    return;
  }

  const armed = await mutateStore((current) => {
    const resumed = resumeTransientUnknownStop(current);
    const run = resumed.controlledRun;
    if (run?.status === "running" || run?.status === "paused") {
      return {
        ...resumed,
        settings: { ...resumed.settings, autoTrading: true },
      };
    }
    if (run?.status === "stopped") {
      return resumed;
    }
    return {
      ...resumed,
      settings: { ...resumed.settings, autoTrading: true },
      controlledRun: emptyControlledRun({
        strategyName: strategy.strategy,
        symbols: strategy.symbols.length ? strategy.symbols : [TICKER],
      }),
    };
  });
  const resumedTransient =
    isTransientInquirySoakStop(state) &&
    (armed.controlledRun?.status === "running" || armed.controlledRun?.status === "paused");
  if (resumedTransient) {
    console.log("\nResumed transient Reconciliation UNKNOWN soak-stop. Positions unchanged.");
  } else {
    console.log("\nControlled run armed. Existing worker/engine ticks will evaluate live KIS quotes.");
  }
  console.log(`startedAt=${armed.controlledRun?.startedAt}`);
  console.log(`status=${armed.controlledRun?.status}`);
  console.log("No forced signals. 0 trades is a valid result.");
  await closeDb();
}

const reportOnly = process.argv.includes("--report");
if (reportOnly) {
  mutateStore((state) => state)
    .then(async (state) => {
      console.log(formatSoakReport(state));
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      await closeDb();
    });
} else {
  main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    await closeDb();
  });
}
