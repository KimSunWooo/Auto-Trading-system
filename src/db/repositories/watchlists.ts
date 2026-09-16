import { newId } from "@/src/db/ids";
import type { Ledger } from "@/src/db/ledger";

/** Foundation only. No watchlist UI in this slice. */
export async function createWatchlist(ledger: Ledger, userId: string, name: string): Promise<string> {
  const id = newId();
  void ledger;
  void userId;
  void name;
  return id;
}
