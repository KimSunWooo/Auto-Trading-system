import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";
import { sma } from "@/src/strategies/indicators";
import { resolveLevel5 } from "@/src/strategies/config";
import { findStock } from "@/lib/universe";

/** Mid risk: 이동평균 돌파 스윙. 종목·이평은 strategy-config.json. */
export class RiskLevel5Strategy implements IStrategy {
  readonly id = "Level5_Swing";
  readonly name = "이평 돌파 스윙";
  readonly riskLevel = 5;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const params = resolveLevel5(bucket.meta);
    const quote = await broker.getQuote(params.ticker);
    if (!quote) {
      return { ...bucket, lastMessage: "스윙 종목 시세 없음" };
    }

    const fast = sma(quote.history, params.fastMa);
    const slow = sma(quote.history, params.slowMa);
    if (fast == null || slow == null) {
      return { ...bucket, lastMessage: "이동평균 워밍업 중" };
    }

    const regime = String(bucket.meta.regime ?? "flat");
    const held = bucket.positions.find((p) => p.code === params.ticker);
    const name = findStock(params.ticker)?.name ?? params.ticker;

    if (fast > slow && regime !== "long") {
      const amount = Math.floor(bucket.balance * params.buyPct);
      const fill = await broker.buyMarket(params.ticker, amount);
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
      const fill = await broker.sellMarket(params.ticker, held.qty);
      return {
        ...bucket,
        lastRunAt: new Date().toISOString(),
        lastMessage: fill.ok ? `데드크로스 전량 매도 ${fill.qty}주` : fill.reason ?? "매도 실패",
        meta: { ...bucket.meta, regime: fill.ok ? "flat" : regime },
      };
    }

    return {
      ...bucket,
      lastMessage: `관망 (${name} MA${params.fastMa} ${Math.round(fast)} / MA${params.slowMa} ${Math.round(slow)})`,
    };
  }
}
