import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function applyEnvFile(filePath: string, overrideExisting: boolean): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (overrideExisting || process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

/**
 * Load env files without printing values.
 * Order: `.env` then `.env.local` (local overrides). Default DB is AWS RDS via `.env.local`.
 */
export function loadLocalEnv(
  filePath = path.join(process.cwd(), ".env.local"),
): void {
  const root = path.dirname(filePath);
  applyEnvFile(path.join(root, ".env"), false);
  applyEnvFile(filePath, true);
}
