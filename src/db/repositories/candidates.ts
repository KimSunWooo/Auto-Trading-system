import { newId, stableId } from "@/src/db/ids";
import type { Ledger } from "@/src/db/ledger";

/** Foundation only. AI recommendation product is not implemented. */
export async function insertTradingCandidate(
  ledger: Ledger,
  input: {
    userId: string;
    brokerAccountId: string;
    instrumentId: string;
    source: "MANUAL_SEARCH" | "WATCHLIST" | "STRATEGY" | "AI_RECOMMENDATION";
    reason?: string;
  },
): Promise<string> {
  const id = newId();
  await ledger.transaction(async (tx) => {
    void tx;
    void stableId;
  });
  return id;
}
