import type { Allocation, Position } from "@/lib/types";

export type AccountBucket = {
  ruleId: string;
  budget: number;
  balance: number;
  enabled: boolean;
  lastRunAt?: string;
  lastMessage?: string;
  meta: Record<string, string | number | boolean | null>;
  positions: Position[];
};

export function toBucket(row: Allocation, positions: Position[]): AccountBucket {
  return {
    ruleId: row.ruleId,
    budget: row.budget,
    balance: row.balance,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    lastMessage: row.lastMessage,
    meta: { ...(row.meta ?? {}) },
    positions: positions.filter((p) => p.ruleId === row.ruleId),
  };
}
