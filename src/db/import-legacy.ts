import { readFileSync } from "node:fs";
import path from "node:path";
import type { AppState } from "@/lib/types";
import { hydratePersistedState } from "@/lib/store";
import { newId } from "@/src/db/ids";
import type { Ledger } from "@/src/db/ledger";
import { projectAppState } from "@/src/db/projector";
import { toMysqlUtc } from "@/src/db/time";
import { getRuleConfig } from "@/src/rules/config";

/**
 * Import current JSON books into the ledger.
 * Does not invent BUY executions from positions-only rows.
 */
export async function importLegacyState(
  ledger: Ledger,
  input: {
    state: AppState;
    sourcePath: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  const startedAt = toMysqlUtc(new Date());
  const result = await projectAppState(ledger, input.state, {
    env: input.env,
    provenance: "LEGACY_STATE",
    sourcePath: input.sourcePath,
  });
  const warnings: string[] = [...result.warnings];
  const filledEvidence = input.state.orders.some((order) => order.status === "filled");
  if (input.state.positions.length > 0 && !filledEvidence) {
    warnings.push("Positions imported with provenance LEGACY_STATE. No synthetic BUY executions were created.");
  }
  await ledger.transaction((tx) =>
    tx.insertMigrationRun({
      id: newId(),
      migrationType: "LEGACY_JSON",
      sourcePath: input.sourcePath,
      status: warnings.length ? "PARTIAL" : "PASS",
      importedOrders: result.imported.orders,
      importedIntents: result.imported.intents,
      importedPositions: result.imported.positions,
      importedRules: result.imported.rules,
      warningsJson: warnings,
      startedAt,
      finishedAt: toMysqlUtc(new Date()),
    }),
  );
  return { ...result, warnings };
}

export function loadLegacyPaperAccount(filePath = path.join(process.cwd(), "data", "paper-account.json")): AppState {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as AppState;
  return hydratePersistedState({ ok: true, value: raw, source: "primary" });
}

export function loadLegacyStrategyConfig() {
  return getRuleConfig();
}
