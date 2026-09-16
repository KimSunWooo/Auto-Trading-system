import type { EnvMap } from "@/src/runtime/trading-mode";

export type PersistenceMode = "json" | "mirror";

export type DbConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

function envOf(env: EnvMap, key: string): string {
  return String(env[key] ?? "").trim();
}

export function persistenceMode(env: EnvMap = process.env): PersistenceMode {
  const raw = envOf(env, "PERSISTENCE_MODE").toLowerCase();
  if (raw === "mirror") return "mirror";
  return "json";
}

export function databaseName(env: EnvMap = process.env): string {
  return envOf(env, "AWS_RDS_DB_NAME") || "auto_trading";
}

/**
 * Prefer DATABASE_URL. Otherwise compose from AWS_RDS_USERNAME / PASSWORD / DATABASE (host).
 * Never log the result.
 */
export function loadDbConnection(env: EnvMap = process.env): DbConnectionConfig | null {
  const url = envOf(env, "DATABASE_URL");
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 3306,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || databaseName(env),
        ssl: parsed.searchParams.get("ssl") !== "false",
      };
    } catch {
      return null;
    }
  }
  const host = envOf(env, "AWS_RDS_DATABASE");
  const user = envOf(env, "AWS_RDS_USERNAME");
  const password = envOf(env, "AWS_RDS_PASSWORD");
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(envOf(env, "AWS_RDS_PORT") || "3306"),
    user,
    password,
    database: databaseName(env),
    ssl: envOf(env, "AWS_RDS_SSL") !== "false",
  };
}

export function dbConfigured(env: EnvMap = process.env): boolean {
  return loadDbConnection(env) != null;
}

export function bootstrapUserEmail(env: EnvMap = process.env): string {
  return envOf(env, "BOOTSTRAP_USER_EMAIL") || "local-owner@localhost";
}
