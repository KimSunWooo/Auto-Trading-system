import type { StateBox } from "@/src/accounts/StateBox";
import { KisBroker } from "@/src/brokers/KisBroker";
import { MockBroker } from "@/src/brokers/MockBroker";
import type { IBroker } from "@/src/brokers/IBroker";
import { brokerDriver } from "@/src/brokers/kis-config";
import { getSharedKisClient } from "@/src/brokers/kis-client";

export function createBroker(box: StateBox, strategyKey = "Level1_Stable"): IBroker {
  if (brokerDriver() === "kis") {
    return new KisBroker(box, getSharedKisClient(), strategyKey);
  }
  return new MockBroker(box, strategyKey);
}

export type { IBroker, BrokerFill, BrokerQuote } from "@/src/brokers/IBroker";
export type { BrokerPublicStatus } from "@/lib/types";
export { MockBroker } from "@/src/brokers/MockBroker";
export { KisBroker } from "@/src/brokers/KisBroker";
export { brokerDriver, getBrokerPublicStatus, loadKisConfig } from "@/src/brokers/kis-config";
export { KisClient, getSharedKisClient } from "@/src/brokers/kis-client";
