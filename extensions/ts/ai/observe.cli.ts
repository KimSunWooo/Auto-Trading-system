import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { observeAiProposals } from "./observe";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "fixture-now": { type: "string" },
      out: { type: "string" },
    },
  });
  const fixtureNow = values["fixture-now"];
  const fixtureNowMs = fixtureNow === undefined ? undefined : Date.parse(fixtureNow);
  if (fixtureNowMs !== undefined && !Number.isFinite(fixtureNowMs)) {
    throw new Error("--fixture-now must be an ISO timestamp");
  }
  const outputDir = values.out ?? (process.env.AI_OBSERVATION_DIR?.trim() ||
    fileURLToPath(new URL("../../.bus/ai-proposals/", import.meta.url)));
  const result = await observeAiProposals({
    baseUrl: process.env.AI_AGENT_BASE_URL ?? "",
    authToken: process.env.AI_AGENT_AUTH_TOKEN,
    fixtureNowMs,
  }, outputDir);
  console.log(JSON.stringify(result, null, 2));
  if (result.rejected.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "AI observation failed");
  process.exitCode = 1;
});
