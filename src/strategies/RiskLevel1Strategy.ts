import { KODEX_200 } from "@/src/accounts/defaults";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";

const INTERVAL_MS = 45_000;
const SLICE_KRW = 150_000;

/** Defensive: KODEX 200 정액 분할 적립. */
export class RiskLevel1Strategy implements IStrategy {
  readonly id = "Level1_Stable";
  readonly name = "안정 적립 (KODEX 200)";
  readonly riskLevel = 1;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const now = Date.now();
    const last = bucket.lastRunAt ? new Date(bucket.lastRunAt).getTime() : 0;
    if (now - last < INTERVAL_MS) {
      return { ...bucket, lastMessage: "적립 주기 대기 중" };
    }

    const amount = Math.min(SLICE_KRW, Math.floor(bucket.balance * 0.05));
    if (amount < 10_000) {
      return { ...bucket, lastMessage: "버킷 잔액이 적어 적립을 건너뜁니다." };
    }

    const fill = await broker.buyMarket(KODEX_200, amount);
    return {
      ...bucket,
      lastRunAt: new Date(now).toISOString(),
      lastMessage: fill.ok
        ? `KODEX 200 ${fill.qty}주 적립 (${fill.net.toLocaleString("ko-KR")}원)`
        : fill.reason ?? "적립 실패",
      meta: { ...bucket.meta, lastFillOk: fill.ok },
    };
  }
}
