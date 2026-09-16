import type { StateBox } from "@/src/accounts/StateBox";
import { KisBroker } from "@/src/brokers/KisBroker";
import { MockBroker } from "@/src/brokers/MockBroker";
import type { IBroker } from "@/src/brokers/IBroker";
import { brokerDriver } from "@/src/brokers/kis-config";
import { getSharedKisClient } from "@/src/brokers/kis-client";

import { CASH_RULE_ID } from "@/src/rules/params";

export function createBroker(box: StateBox, ruleKey = CASH_RULE_ID): IBroker {
  if (brokerDriver() === "kis") {
    return new KisBroker(box, getSharedKisClient(), ruleKey);
  }
  return new MockBroker(box, ruleKey);
}

export type { IBroker, BrokerFill, BrokerQuote } from "@/src/brokers/IBroker";
export type { BrokerPublicStatus } from "@/lib/types";
export { MockBroker } from "@/src/brokers/MockBroker";
export { KisBroker } from "@/src/brokers/KisBroker";
export { brokerDriver, getBrokerPublicStatus, getKisConfig, loadKisConfig, KIS_TR, KIS_OVERSEAS_TR } from "@/src/brokers/kis-config";
export { KisClient, getSharedKisClient } from "@/src/brokers/kis-client";
