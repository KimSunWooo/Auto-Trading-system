import { newId } from "@/src/db/ids";
import type { Ledger } from "@/src/db/ledger";

/** Foundation only. Delivery is not implemented. */
export async function enqueueNotification(
  ledger: Ledger,
  input: { userId: string; type: string; title: string; message: string; severity?: "INFO" | "WARNING" | "CRITICAL" },
): Promise<string> {
  const id = newId();
  void ledger;
  void input;
  return id;
}
