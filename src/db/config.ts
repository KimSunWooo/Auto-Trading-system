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
 * Prefer DATABASE_URL (mysql://… or host:port/db).
 * Credentials may come from the URL or DATABASE_USER_NAME / DATABASE_PASSWORD
 * (also AWS_RDS_USERNAME / AWS_RDS_PASSWORD). Never log the result.
 *
 * Legacy typo alias DATABASE_PASSOWORD is accepted with a one-time warning
 * (value never printed). Prefer DATABASE_PASSWORD.
 */
let warnedPassowordAlias = false;

export function warnDeprecatedPasswordAlias(env: EnvMap = process.env): void {
  if (warnedPassowordAlias) return;
  const hasTypo = Boolean(envOf(env, "DATABASE_PASSOWORD"));
  const hasCorrect = Boolean(envOf(env, "DATABASE_PASSWORD"));
  if (hasTypo && !hasCorrect) {
    warnedPassowordAlias = true;
    console.warn(
      "[db] DATABASE_PASSOWORD is a deprecated typo alias; set DATABASE_PASSWORD instead (value not shown).",
    );
  }
}

export function loadDbConnection(env: EnvMap = process.env): DbConnectionConfig | null {
  const url = envOf(env, "DATABASE_URL");
  const userFallback =
    envOf(env, "DATABASE_USER_NAME") ||
    envOf(env, "DATABASE_USERNAME") ||
    envOf(env, "AWS_RDS_USERNAME");
  warnDeprecatedPasswordAlias(env);
  const passwordFallback =
    envOf(env, "DATABASE_PASSWORD") ||
    envOf(env, "DATABASE_PASSOWORD") ||
    envOf(env, "AWS_RDS_PASSWORD");

  if (url) {
    const fromMysql = parseMysqlUrl(url, userFallback, passwordFallback, env);
    if (fromMysql) return fromMysql;
    const fromHost = parseHostDbUrl(url, userFallback, passwordFallback, env);
    if (fromHost) return fromHost;
  }

  const host = envOf(env, "AWS_RDS_DATABASE");
  const user = userFallback;
  const password = passwordFallback;
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

function parseMysqlUrl(
  url: string,
  userFallback: string,
  passwordFallback: string,
  env: EnvMap,
): DbConnectionConfig | null {
  if (!/^mysql2?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const user = decodeURIComponent(parsed.username || "") || userFallback;
    const password = decodeURIComponent(parsed.password || "") || passwordFallback;
    if (!parsed.hostname || !user || !password) return null;
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user,
      password,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || databaseName(env),
      ssl: parsed.searchParams.get("ssl") !== "false",
    };
  } catch {
    return null;
  }
}

/** host:3306/db?ssl=false (no credentials in URL) */
function parseHostDbUrl(
  raw: string,
  userFallback: string,
  passwordFallback: string,
  env: EnvMap,
): DbConnectionConfig | null {
  if (!userFallback || !passwordFallback) return null;
  let rest = raw.trim();
  if (!rest || /^mysql2?:\/\//i.test(rest)) return null;
  if (rest.includes("://")) rest = rest.split("://", 2)[1] ?? rest;
  let query = "";
  if (rest.includes("?")) {
    const parts = rest.split("?", 2);
    rest = parts[0] ?? rest;
    query = parts[1] ?? "";
  }
  let hostPort = rest;
  let database = databaseName(env);
  if (rest.includes("/")) {
    const idx = rest.indexOf("/");
    hostPort = rest.slice(0, idx);
    database = rest.slice(idx + 1) || database;
  }
  let host = hostPort;
  let port = 3306;
  if (hostPort.includes(":")) {
    const idx = hostPort.lastIndexOf(":");
    host = hostPort.slice(0, idx);
    port = Number(hostPort.slice(idx + 1)) || 3306;
  }
  if (!host) return null;
  const params = new URLSearchParams(query);
  return {
    host,
    port,
    user: userFallback,
    password: passwordFallback,
    database,
    ssl: params.get("ssl") !== "false",
  };
}

export function dbConfigured(env: EnvMap = process.env): boolean {
  return loadDbConnection(env) != null;
}

export function bootstrapUserEmail(env: EnvMap = process.env): string {
  return envOf(env, "BOOTSTRAP_USER_EMAIL") || "local-owner@localhost";
}
