/**
 * CLI: KIS PAPER WebSocket H0STCNT0 read-only soak.
 * Does NOT enable autoTrading. Do not use soak:preflight for this check.
 *
 *   WS_SOAK_SECONDS=300 npm run paper:ws:soak
 */
import { loadLocalEnv } from "@/src/db/load-env";

loadLocalEnv();
process.env.KIS_MODE ??= "paper";
process.env.BROKER ??= "kis";
if (process.env.ALLOW_LIVE_TRADING === "true") {
  throw new Error("Refuse: ALLOW_LIVE_TRADING must stay false");
}
delete process.env.KIS_LIVE_CONFIRM;
delete process.env.RUN_KIS_VTS_OVERSEAS_ORDER_TESTS;
delete process.env.RUN_KIS_VTS_ORDER_TESTS;

import {
  formatFinalReport,
  runPaperWsReadOnlySoak,
} from "@/src/market-data/kis-paper-ws-soak";

async function main(): Promise<void> {
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const report = await runPaperWsReadOnlySoak({ signal: ac.signal });
    console.log("");
    console.log(formatFinalReport(report));
    const ok =
      report.final.actualKisPaperConnection === "PASS" &&
      report.final.h0stcnt0LiveData === "PASS" &&
      report.final.readOnlySoak === "PASS";
    // Fresh stream may fail off-hours; still exit non-zero if no live quote.
    process.exitCode = ok ? 0 : 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
