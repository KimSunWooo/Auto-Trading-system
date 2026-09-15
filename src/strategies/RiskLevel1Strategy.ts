import { nowMs } from "@/src/clock";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";
import { resolveLevel1 } from "@/src/strategies/config";
import { findStock } from "@/lib/universe";

/** Defensive: ETF 정액 분할 적립. 종목·주기·슬라이스는 strategy-config.json. */
export class RiskLevel1Strategy implements IStrategy {
  readonly id = "Level1_Stable";
  readonly name = "안정 적립";
  readonly riskLevel = 1;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const params = resolveLevel1(bucket.meta);
    const now = nowMs();
    const last = bucket.lastRunAt ? new Date(bucket.lastRunAt).getTime() : 0;
    if (now - last < params.intervalMs) {
      return { ...bucket, lastMessage: "적립 주기 대기 중" };
    }

    const amount = Math.min(params.sliceKrw, Math.floor(bucket.balance * params.slicePct));
    if (amount < params.minAmountKrw) {
      return { ...bucket, lastMessage: "버킷 잔액이 적어 적립을 건너뜁니다." };
    }

    const fill = await broker.buyMarket(params.ticker, amount);
    const sent = fill.ok || fill.status === "pending" || fill.status === "unknown";
    const name = findStock(params.ticker)?.name ?? params.ticker;
    return {
      ...bucket,
      lastRunAt: new Date(now).toISOString(),
      lastMessage: fill.ok
        ? `${name} ${fill.qty}주 적립 (${fill.net.toLocaleString("ko-KR")}원)`
        : fill.status === "pending"
          ? `${name} ${fill.qty}주 주문 접수 (체결 대기)`
          : fill.reason ?? "적립 실패",
      meta: { ...bucket.meta, lastFillOk: sent },
    };
  }
}
