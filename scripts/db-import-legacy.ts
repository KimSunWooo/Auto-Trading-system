import path from "node:path";
import { existsSync } from "node:fs";
import { loadLocalEnv } from "@/src/db/load-env";
import { dbConfigured, persistenceMode } from "@/src/db/config";
import { getMysqlLedger } from "@/src/db/mysql-ledger";
import { importLegacyState, loadLegacyPaperAccount } from "@/src/db/import-legacy";

loadLocalEnv();

async function main() {
  if (process.env.CONFIRM_LEGACY_IMPORT !== "YES") {
    console.error("Refusing to import. Set CONFIRM_LEGACY_IMPORT=YES to write to the configured database.");
    process.exitCode = 2;
    return;
  }
  if (persistenceMode() !== "mirror") {
    console.error("PERSISTENCE_MODE must be mirror for legacy import.");
    process.exitCode = 2;
    return;
  }
  if (!dbConfigured()) {
    console.error("DATABASE_URL / AWS_RDS_* is required.");
    process.exitCode = 2;
    return;
  }
  const file = path.join(process.cwd(), "data", "paper-account.json");
  if (!existsSync(file)) {
    console.error("data/paper-account.json is missing.");
    process.exitCode = 2;
    return;
  }
  const state = loadLegacyPaperAccount(file);
  const ledger = getMysqlLedger();
  const result = await importLegacyState(ledger, { state, sourcePath: "data/paper-account.json" });
  console.log(
    JSON.stringify(
      {
        status: "ok",
        imported: result.imported,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "import failed");
  process.exitCode = 1;
});
