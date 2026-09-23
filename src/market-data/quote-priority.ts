/**
 * WebSocket subscription priority.
 * Execution tickers must never be evicted by dashboard/preview consumers.
 *
 * Priority 1 — execution: held positions, working orders, enabled rules, conditions, DCA
 * Priority 2 — preview: short-lived selected instrument
 * Priority 3 — representative dashboard
 */
export const QUOTE_PRIORITY = {
  execution: 1,
  preview: 2,
  dashboard: 3,
} as const;

export type QuotePriorityName = keyof typeof QUOTE_PRIORITY;

export const LOW_PRIORITY_CONSUMER_PREFIXES = ["preview:", "dashboard:"] as const;

export function isLowPriorityConsumer(consumerId: string): boolean {
  const id = String(consumerId ?? "");
  return LOW_PRIORITY_CONSUMER_PREFIXES.some((p) => id.startsWith(p));
}

export function dashboardConsumerId(brokerAccountId: string): string {
  return `dashboard:${brokerAccountId}`;
}

export function previewConsumerId(brokerAccountId: string): string {
  return `preview:${brokerAccountId}`;
}

/** Execution consumer keeps the bare brokerAccountId (legacy / soak compatible). */
export function executionConsumerId(brokerAccountId: string): string {
  return brokerAccountId;
}
