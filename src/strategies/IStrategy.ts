import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";

export interface IStrategy {
  readonly id: string;
  readonly name: string;
  readonly riskLevel: number;
  execute(broker: IBroker, accountBucket: AccountBucket): Promise<AccountBucket>;
}
