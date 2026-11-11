import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pullAiTradeProposals, type AiPullConfig } from "../../../src/ai/pull-consumer";
import type { AiTradeProposalV1 } from "../../../src/ai/trade-proposal-v1";

async function saveObservation(root: string, proposal: AiTradeProposalV1): Promise<boolean> {
  const key = createHash("sha256").update(proposal.proposalId).digest("hex");
  const stagingDir = await mkdtemp(path.join(root, ".pending-"));
  const staged = path.join(stagingDir, "observation.json");
  try {
    await writeFile(staged, JSON.stringify({
      proposal,
      observedAt: new Date().toISOString(),
      orderEligible: false,
      autoOrderEnabled: false,
    }, null, 2) + "\n", { mode: 0o600 });
    // A completed file becomes visible exactly once, including across concurrent runs.
    await link(staged, path.join(root, `${key}.json`));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function observeAiProposals(cfg: AiPullConfig, outputDir: string) {
  const result = await pullAiTradeProposals({ ...cfg, includeNonOrderActions: true });
  let stored = 0;
  if (result.accepted.length) await mkdir(outputDir, { recursive: true, mode: 0o700 });
  for (const proposal of result.accepted) {
    if (await saveObservation(outputDir, proposal)) stored += 1;
  }
  return { ...result, stored, duplicates: result.accepted.length - stored };
}
