import { nowIso, nowMs } from "@/src/clock";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";
import { rangeBreak } from "@/src/strategies/indicators";
import { resolveLevel10 } from "@/src/strategies/config";

/** Aggressive: 변동성 돌파 추격. 유니버스·K·쿨다운은 strategy-config.json. */
export class RiskLevel10Strategy implements IStrategy {
  readonly id = "Level10_Aggressive";
  readonly name = "변동성 돌파 추격";
  readonly riskLevel = 10;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const params = resolveLevel10(bucket.meta);
    const now = nowMs();
    const lastFire = Number(bucket.meta.firedAt ?? 0);
    if (now - lastFire < params.cooldownMs) {
      return { ...bucket, lastMessage: "추격 매수 쿨다운" };
    }

    let best: { ticker: string; score: number } | null = null;

    for (const ticker of params.universe) {
      const quote = await broker.getQuote(ticker);
      if (!quote || quote.prevClose <= 0) continue;
      const ret = (quote.price - quote.prevClose) / quote.prevClose;
      const breakout = quote.price >= rangeBreak(quote.open, quote.high, quote.low, params.k);
      if (!breakout) continue;
      if (!best || ret > best.score) {
        best = { ticker, score: ret };
      }
    }

    if (!best || best.score < params.minDayReturn) {
      return { ...bucket, lastMessage: "돌파 종목 없음" };
    }

    const amount = Math.floor(bucket.balance * params.buyPct);
    const fill = await broker.buyMarket(best.ticker, amount);
    const sent = fill.ok || fill.status === "unknown" || fill.status === "pending";
    return {
      ...bucket,
      lastRunAt: nowIso(),
      lastMessage: fill.ok
        ? `${best.ticker} 변동성 돌파 추격 ${fill.qty}주 (${(best.score * 100).toFixed(2)}%)`
        : fill.status === "pending"
          ? `${best.ticker} 추격 주문 접수 (체결 대기)`
          : fill.reason ?? "추격 실패",
      meta: {
        ...bucket.meta,
        firedAt: sent ? now : lastFire,
        lastTicker: best.ticker,
      },
    };
  }
}
