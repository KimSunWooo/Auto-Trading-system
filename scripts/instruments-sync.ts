#!/usr/bin/env tsx
/**
 * Sync instrument masters into MySQL.
 *
 * Production (default):
 *   npx tsx scripts/instruments-sync.ts
 *   → KOSPI/KOSDAQ/KONEX MST zip + NASDAQ/NYSE/AMEX trader listings
 *
 * Explicit fixture / unit sample load only:
 *   INSTRUMENTS_SYNC_MODE=fixture npx tsx scripts/instruments-sync.ts
 *
 * Never calls KIS trading APIs. Source-isolated sync.
 */
import path from "node:path";
import {
  fixtureSyncSources,
  productionSyncSources,
  syncInstrumentSources,
} from "@/src/instruments/sync";

async function main() {
  const mode = (process.env.INSTRUMENTS_SYNC_MODE ?? "production").trim().toLowerCase();
  const sources =
    mode === "fixture"
      ? fixtureSyncSources(
          process.env.INSTRUMENTS_FIXTURES_DIR?.trim() ||
            path.join(process.cwd(), "src/instruments/fixtures"),
        )
      : productionSyncSources();
  console.log(`[instruments-sync] mode=${mode} sources=${sources.map((s) => s.id).join(",")}`);
  if (mode !== "fixture") {
    const usesFixture = sources.some((s) => s.fixture || s.input.kind === "file");
    if (usesFixture) {
      console.error("PRODUCTION sync refused: fixture/file sources detected");
      process.exitCode = 1;
      return;
    }
  }
  const results = await syncInstrumentSources(sources);
  for (const row of results) {
    const mark = row.status === "SUCCESS" ? "ok" : "FAIL";
    console.log(
      `[${mark}] ${row.source} total=${row.totalCount} +${row.insertedCount} ~${row.updatedCount} -${row.deactivatedCount}` +
        (row.error ? ` error=${row.error}` : ""),
    );
  }
  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
