import type { StateBox } from "@/src/accounts/StateBox";
import { KisBroker } from "@/src/brokers/KisBroker";
import type { IBroker } from "@/src/brokers/IBroker";
import { getSharedKisClient, type KisApi } from "@/src/brokers/kis-client";
import type { AppState } from "@/lib/types";

import { CASH_RULE_ID } from "@/src/rules/params";

export type CreateBrokerOpts = {
  kisClient?: KisApi;
  persistState?: (state: AppState) => Promise<void>;
  safety?: import("@/src/runtime/trading-safety").TradingSafetyContext;
  /** PAPER WebSocket quote hub — process-local, never persisted. */
  quoteHub?: import("@/src/market-data/kis-realtime-quote-hub").RealtimeQuoteHub | null;
};

export class BrokerNotReadyError extends Error {
  readonly code: "KIS_PAPER_RUNTIME_NOT_READY" | "KIS_PAPER_ACCOUNT_NOT_CONNECTED";
  constructor(
    code: "KIS_PAPER_RUNTIME_NOT_READY" | "KIS_PAPER_ACCOUNT_NOT_CONNECTED",
    message: string,
  ) {
    super(message);
    this.name = "BrokerNotReadyError";
    this.code = code;
  }
}

/**
 * Production broker factory — KisBroker only.
 * Never falls back to a local mock book.
 */
export function createBroker(
  box: StateBox,
  ruleKey = CASH_RULE_ID,
  opts: CreateBrokerOpts = {},
): IBroker {
  const client = opts.kisClient ?? getSharedKisClient();
  if (!client?.configured) {
    throw new BrokerNotReadyError(
      "KIS_PAPER_RUNTIME_NOT_READY",
      "KIS PAPER runtime is not ready — local mock book is not available",
    );
  }
  return new KisBroker(box, client, ruleKey, "rule", undefined, undefined, {
    persistState: opts.persistState,
    safety: opts.safety,
    quoteHub: opts.quoteHub,
  });
}

/**
 * Account RuntimeScope entry — uses injected KIS client only.
 * Does not re-read global BROKER env.
 */
export function createBrokerForRuntime(
  box: StateBox,
  opts: {
    kisClient: KisApi;
    persistState: (state: AppState) => Promise<void>;
    ruleKey?: string;
    safety?: import("@/src/runtime/trading-safety").TradingSafetyContext;
    quoteHub?: import("@/src/market-data/kis-realtime-quote-hub").RealtimeQuoteHub | null;
  },
): IBroker {
  if (!opts.kisClient?.configured) {
    throw new BrokerNotReadyError(
      "KIS_PAPER_ACCOUNT_NOT_CONNECTED",
      "KIS PAPER account client is not configured",
    );
  }
  return new KisBroker(
    box,
    opts.kisClient,
    opts.ruleKey ?? CASH_RULE_ID,
    "rule",
    undefined,
    undefined,
    {
      persistState: opts.persistState,
      safety: opts.safety,
      quoteHub: opts.quoteHub,
    },
  );
}

export type { IBroker, BrokerFill, BrokerQuote } from "@/src/brokers/IBroker";
export type { BrokerPublicStatus } from "@/lib/types";
export { KisBroker } from "@/src/brokers/KisBroker";
export {
  getBrokerPublicStatus,
  getKisConfig,
  loadKisConfig,
  KIS_TR,
  KIS_OVERSEAS_TR,
} from "@/src/brokers/kis-config";
export { KisClient, getSharedKisClient } from "@/src/brokers/kis-client";
