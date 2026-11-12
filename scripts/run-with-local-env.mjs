#!/usr/bin/env node
/**
 * Force-load .env then .env.local (local wins) into process.env, then exec the
 * remaining argv. Ensures injected shell DATABASE_URL (e.g. local docker :3307)
 * cannot override the project's RDS settings in .env.local.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function applyEnvFile(filePath, { override }) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
    if (override || process.env[key] == null) process.env[key] = value;
  }
}

const root = process.cwd();
applyEnvFile(path.join(root, ".env"), { override: false });
applyEnvFile(path.join(root, ".env.local"), { override: true });

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/run-with-local-env.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(args[0], args.slice(1), {
  stdio: "inherit",
  env: process.env,
  shell: false,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
