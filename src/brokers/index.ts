import type { StateBox } from "@/src/accounts/StateBox";
import { KisBroker } from "@/src/brokers/KisBroker";
import { MockBroker } from "@/src/brokers/MockBroker";
import type { IBroker } from "@/src/brokers/IBroker";
import { brokerDriver } from "@/src/brokers/kis-config";
import { getSharedKisClient, type KisApi } from "@/src/brokers/kis-client";
import type { AppState } from "@/lib/types";

import { CASH_RULE_ID } from "@/src/rules/params";

export type CreateBrokerOpts = {
  kisClient?: KisApi;
  persistState?: (state: AppState) => Promise<void>;
  safety?: import("@/src/runtime/trading-safety").TradingSafetyContext;
};

export function createBroker(
  box: StateBox,
  ruleKey = CASH_RULE_ID,
  opts: CreateBrokerOpts = {},
): IBroker {
  if (brokerDriver() === "kis") {
    return new KisBroker(box, opts.kisClient ?? getSharedKisClient(), ruleKey, "rule", undefined, undefined, {
      persistState: opts.persistState,
      safety: opts.safety,
    });
  }
  return new MockBroker(box, ruleKey);
}

/** Account RuntimeScope entry — uses injected KIS client + persister + safety. */
export function createBrokerForRuntime(
  box: StateBox,
  opts: {
    kisClient: KisApi;
    persistState: (state: AppState) => Promise<void>;
    ruleKey?: string;
    safety?: import("@/src/runtime/trading-safety").TradingSafetyContext;
  },
): IBroker {
  return createBroker(box, opts.ruleKey ?? CASH_RULE_ID, {
    kisClient: opts.kisClient,
    persistState: opts.persistState,
    safety: opts.safety,
  });
}

export type { IBroker, BrokerFill, BrokerQuote } from "@/src/brokers/IBroker";
export type { BrokerPublicStatus } from "@/lib/types";
export { MockBroker } from "@/src/brokers/MockBroker";
export { KisBroker } from "@/src/brokers/KisBroker";
export { brokerDriver, getBrokerPublicStatus, getKisConfig, loadKisConfig, KIS_TR, KIS_OVERSEAS_TR } from "@/src/brokers/kis-config";
export { KisClient, getSharedKisClient } from "@/src/brokers/kis-client";
