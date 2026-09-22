import { loadLocalEnv } from "@/src/db/load-env";
loadLocalEnv();

async function main() {
  const { ensureAuthSchema } = await import("@/src/auth/ensure-schema");
  await ensureAuthSchema();
  console.log("ensureAuthSchema OK");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
