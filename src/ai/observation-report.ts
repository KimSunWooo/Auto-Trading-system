import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateAiTradeProposalV1, type AiTradeProposalV1 } from "./trade-proposal-v1";

export type AiObservation = { proposal: AiTradeProposalV1; observedAt: string };

export function summarizeAiObservations(observations: readonly AiObservation[], nowMs = Date.now()) {
  const sorted = [...observations].sort((a, b) =>
    Date.parse(b.proposal.analysisAsOf) - Date.parse(a.proposal.analysisAsOf) ||
    Date.parse(b.proposal.generatedAt) - Date.parse(a.proposal.generatedAt) ||
    Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
    a.proposal.proposalId.localeCompare(b.proposal.proposalId),
  );
  const seen = new Set<string>();
  const latest = sorted.filter(({ proposal }) => {
    const key = `${proposal.dataMode}:${proposal.market}:${proposal.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const recommendations = latest.filter(({ proposal }) =>
    proposal.action === "BUY" && proposal.dataMode === "LIVE_OBSERVATION" &&
    Date.parse(proposal.generatedAt) <= nowMs && nowMs < Date.parse(proposal.validUntil),
  );
  return { recommendations, latest };
}

export async function readAiObservationReport(
  directory = process.env.AI_OBSERVATION_DIR?.trim() || path.resolve("extensions/.bus/ai-proposals"),
) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const observations: AiObservation[] = [];
  let invalidCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as {
        proposal?: { generatedAt?: string };
        observedAt?: string;
        orderEligible?: boolean;
        autoOrderEnabled?: boolean;
      } | null;
      if (!record?.observedAt || !Number.isFinite(Date.parse(record.observedAt)) ||
          record.orderEligible !== false || record.autoOrderEnabled !== false) {
        invalidCount += 1;
        continue;
      }
      const verified = validateAiTradeProposalV1(record.proposal, {
        includeNonOrderActions: true,
        // Retain expired records as history. Current recommendations use the real clock.
        nowMs: Date.parse(record.proposal?.generatedAt ?? ""),
      });
      if (verified.ok) observations.push({ proposal: verified.proposal, observedAt: record.observedAt });
      else invalidCount += 1;
    } catch {
      invalidCount += 1;
    }
  }
  const evaluatedAt = Date.now();
  return { ...summarizeAiObservations(observations, evaluatedAt), evaluatedAt, invalidCount };
}
