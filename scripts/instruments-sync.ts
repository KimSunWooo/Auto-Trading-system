#!/usr/bin/env tsx
/**
 * Load instrument masters from fixtures (or URLs via env overrides).
 * Never calls KIS. Source-isolated sync.
 *
 *   npx tsx scripts/instruments-sync.ts
 *   INSTRUMENTS_FIXTURES_DIR=/path npx tsx scripts/instruments-sync.ts
 */
import path from "node:path";
import { fixtureSyncSources, syncInstrumentSources } from "@/src/instruments/sync";

async function main() {
  const fixturesDir =
    process.env.INSTRUMENTS_FIXTURES_DIR?.trim() ||
    path.join(process.cwd(), "src/instruments/fixtures");
  const sources = fixtureSyncSources(fixturesDir);
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
