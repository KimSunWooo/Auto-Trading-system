import { newId } from "@/src/db/ids";
import type { Ledger } from "@/src/db/ledger";
import { toMysqlUtc } from "@/src/db/time";

const ALLOWED = new Set([
  "AUTO_TRADING_ENABLED",
  "AUTO_TRADING_DISABLED",
  "REAL_TRADING_ENABLED",
  "REAL_TRADING_DISABLED",
  "RISK_SETTING_CHANGED",
  "MANUAL_ORDER_REQUESTED",
  "EMERGENCY_STOP",
  "FLATTEN_REQUESTED",
  "STRATEGY_CHANGED",
]);

/** Foundation only. Never persist credentials. */
export async function recordAuditEvent(
  ledger: Ledger,
  input: {
    action: string;
    userId?: string | null;
    brokerAccountId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  if (!ALLOWED.has(input.action)) return;
  await ledger.transaction((tx) =>
    tx.insertAudit({
      id: newId(),
      userId: input.userId ?? null,
      brokerAccountId: input.brokerAccountId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      beforeDataJson: input.before ?? null,
      afterDataJson: input.after ?? null,
    }),
  );
}

export function auditNow(): string {
  return toMysqlUtc(new Date());
}
