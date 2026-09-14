import type { StateBox } from "@/src/accounts/StateBox";
import { KisBroker } from "@/src/brokers/KisBroker";
import { MockBroker } from "@/src/brokers/MockBroker";
import type { IBroker } from "@/src/brokers/IBroker";

export function createBroker(box: StateBox, strategyKey?: string): IBroker {
  const driver = process.env.BROKER ?? "mock";
  if (driver === "kis") {
    return new KisBroker({
      appKey: process.env.KIS_APP_KEY,
      appSecret: process.env.KIS_APP_SECRET,
      accountNo: process.env.KIS_ACCOUNT_NO,
      mode: process.env.KIS_MODE === "real" ? "real" : "demo",
    });
  }
  return new MockBroker(box, strategyKey);
}

export type { IBroker, BrokerFill, BrokerQuote } from "@/src/brokers/IBroker";
export { MockBroker } from "@/src/brokers/MockBroker";
export { KisBroker } from "@/src/brokers/KisBroker";
