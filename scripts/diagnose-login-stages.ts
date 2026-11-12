/**
 * Stage-split login diagnosis for existing users. Never prints secrets or emails.
 */
import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

import { eq } from "drizzle-orm";
import { getDb, resetDbClientForTest } from "@/src/db/client";
import { loadDbConnection } from "@/src/db/config";
import * as schema from "@/src/db/schema";
import { verifyPassword } from "@/src/auth/password";
import { loginUser } from "@/src/auth/session";

async function main() {
  const cfg = loadDbConnection();
  console.log("db-target:", {
    host: cfg?.host ?? null,
    port: cfg?.port ?? null,
    database: cfg?.database ?? null,
    envUrlPresent: Boolean(process.env.DATABASE_URL),
  });

  const db = getDb();
  if (!db) throw new Error("no db");

  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      status: schema.users.status,
      deletedAt: schema.users.deletedAt,
      passwordHash: schema.users.passwordHash,
    })
    .from(schema.users)
    .limit(50);

  const knownProbes = ["PaperVerify!2026"];
  const out = [];
  for (const u of rows) {
    const accounts = await db
      .select({
        env: schema.brokerAccounts.environment,
        status: schema.brokerAccounts.status,
      })
      .from(schema.brokerAccounts)
      .where(eq(schema.brokerAccounts.userId, u.id));

    let accountLookup: "found" | "deleted" | "suspended" | "missing_hash" = "found";
    if (u.deletedAt) accountLookup = "deleted";
    else if (u.status === "SUSPENDED") accountLookup = "suspended";
    else if (!u.passwordHash) accountLookup = "missing_hash";

    let passwordStage: "match_known_probe" | "mismatch_or_unknown" | "skipped" = "skipped";
    let sessionStage: "ok" | "fail" | "skipped" = "skipped";
    if (accountLookup === "found" && u.passwordHash && u.email) {
      const matched = knownProbes.some((p) => verifyPassword(p, u.passwordHash!));
      passwordStage = matched ? "match_known_probe" : "mismatch_or_unknown";
      if (matched) {
        try {
          await loginUser({ email: u.email, password: knownProbes[0]! });
          sessionStage = "ok";
        } catch {
          sessionStage = "fail";
        }
      }
    }

    out.push({
      emailLocalLen: (u.email ?? "").split("@")[0]?.length ?? 0,
      emailDomain: (u.email ?? "").split("@")[1] ?? "?",
      status: u.status,
      accountLookup,
      passwordStage,
      sessionStage,
      kisConnectSeparate: true,
      paperActive: accounts.filter((a) => a.env === "PAPER" && a.status === "ACTIVE").length,
      realActive: accounts.filter((a) => a.env === "REAL" && a.status === "ACTIVE").length,
    });
  }
  console.log(JSON.stringify({ userCount: out.length, users: out }, null, 2));
  resetDbClientForTest();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
