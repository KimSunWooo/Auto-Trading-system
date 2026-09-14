import { SWING_TICKER } from "@/src/accounts/defaults";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";
import { sma } from "@/src/strategies/indicators";

/** Mid risk: 5/20 이동평균 돌파 스윙 (삼성전자). */
export class RiskLevel5Strategy implements IStrategy {
  readonly id = "Level5_Swing";
  readonly name = "이평 돌파 스윙";
  readonly riskLevel = 5;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const quote = await broker.getQuote(SWING_TICKER);
    if (!quote) {
      return { ...bucket, lastMessage: "스윙 종목 시세 없음" };
    }

    const fast = sma(quote.history, 5);
    const slow = sma(quote.history, 20);
    if (fast == null || slow == null) {
      return { ...bucket, lastMessage: "이동평균 워밍업 중" };
    }

    const regime = String(bucket.meta.regime ?? "flat");
    const held = bucket.positions.find((p) => p.code === SWING_TICKER);

    if (fast > slow && regime !== "long") {
      const amount = Math.floor(bucket.balance * 0.35);
      const fill = await broker.buyMarket(SWING_TICKER, amount);
      const sent = fill.ok || fill.status === "pending" || fill.status === "unknown";
      return {
        ...bucket,
        lastRunAt: new Date().toISOString(),
        lastMessage: fill.ok
          ? `골든크로스 매수 ${fill.qty}주`
          : fill.status === "pending"
            ? `골든크로스 주문 접수 (${fill.qty}주, 체결 대기)`
            : fill.reason ?? "매수 실패",
        meta: {
          ...bucket.meta,
          regime: fill.ok ? "long" : fill.status === "unknown" ? "halt" : regime,
          lastFillOk: sent,
        },
      };
    }

    if (fast < slow && regime === "long" && held && held.qty > 0) {
      const fill = await broker.sellMarket(SWING_TICKER, held.qty);
      return {
        ...bucket,
        lastRunAt: new Date().toISOString(),
        lastMessage: fill.ok ? `데드크로스 전량 매도 ${fill.qty}주` : fill.reason ?? "매도 실패",
        meta: { ...bucket.meta, regime: fill.ok ? "flat" : regime },
      };
    }

    return {
      ...bucket,
      lastMessage: `관망 (MA5 ${Math.round(fast)} / MA20 ${Math.round(slow)})`,
    };
  }
}
