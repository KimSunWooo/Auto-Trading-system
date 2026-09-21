import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { loadDbConnection, persistenceMode, dbConfigured } from "@/src/db/config";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i);
  let v = t.slice(i + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v;
}

async function tryConnect(
  cfg: NonNullable<ReturnType<typeof loadDbConnection>>,
  ssl: boolean | object | undefined,
  label: string,
) {
  try {
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: ssl as any,
      connectTimeout: 20000,
    });
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ?",
      [cfg.database],
    );
    const c = Number((rows as Array<{ c: number }>)[0]?.c ?? 0);
    await conn.end();
    console.log(JSON.stringify({ label, ok: true, tables: c }));
    return c;
  } catch (err) {
    console.log(
      JSON.stringify({
        label,
        ok: false,
        code: (err as { code?: string })?.code,
        message: err instanceof Error ? err.message.slice(0, 220) : String(err).slice(0, 220),
      }),
    );
    return null;
  }
}

async function main() {
  const cfg = loadDbConnection();
  console.log(
    JSON.stringify(
      {
        configured: dbConfigured(),
        mode: persistenceMode(),
        host: cfg?.host,
        port: cfg?.port,
        database: cfg?.database,
        user: cfg?.user,
        ssl: cfg?.ssl,
      },
      null,
      2,
    ),
  );
  if (!cfg) throw new Error("no db config");

  let tables = await tryConnect(cfg, cfg.ssl ? { rejectUnauthorized: false } : undefined, "url-ssl-setting");
  if (tables == null) {
    tables = await tryConnect(cfg, { rejectUnauthorized: false }, "ssl-rejectUnauthorized-false");
  }
  if (tables == null) throw new Error("CONNECT_FAIL");
  if (tables < 30) console.log("SCHEMA_INCOMPLETE", tables);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
