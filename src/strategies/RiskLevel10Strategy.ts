import { AGGRESSIVE_UNIVERSE } from "@/src/accounts/defaults";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import type { IStrategy } from "@/src/strategies/IStrategy";
import { rangeBreak } from "@/src/strategies/indicators";

const COOLDOWN_MS = 120_000;

/** Aggressive: 변동성 돌파 후 당일 1회 시장가 추격. */
export class RiskLevel10Strategy implements IStrategy {
  readonly id = "Level10_Aggressive";
  readonly name = "변동성 돌파 추격";
  readonly riskLevel = 10;

  async execute(broker: IBroker, bucket: AccountBucket): Promise<AccountBucket> {
    const lastFire = Number(bucket.meta.firedAt ?? 0);
    if (Date.now() - lastFire < COOLDOWN_MS) {
      return { ...bucket, lastMessage: "추격 매수 쿨다운" };
    }

    const universe = AGGRESSIVE_UNIVERSE;
    let best: { ticker: string; score: number } | null = null;

    for (const ticker of universe) {
      const quote = await broker.getQuote(ticker);
      if (!quote || quote.prevClose <= 0) continue;
      const ret = (quote.price - quote.prevClose) / quote.prevClose;
      const breakout = quote.price >= rangeBreak(quote.open, quote.high, quote.low, 0.4);
      if (!breakout) continue;
      if (!best || ret > best.score) {
        best = { ticker, score: ret };
      }
    }

    if (!best || best.score < 0.004) {
      return { ...bucket, lastMessage: "돌파 종목 없음" };
    }

    const amount = Math.floor(bucket.balance * 0.25);
    const fill = await broker.buyMarket(best.ticker, amount);
    const sent = fill.ok || fill.status === "unknown" || fill.status === "pending";
    return {
      ...bucket,
      lastRunAt: new Date().toISOString(),
      lastMessage: fill.ok
        ? `${best.ticker} 변동성 돌파 추격 ${fill.qty}주 (${(best.score * 100).toFixed(2)}%)`
        : fill.reason ?? "추격 실패",
      meta: {
        ...bucket.meta,
        firedAt: sent ? Date.now() : lastFire,
        lastTicker: best.ticker,
      },
    };
  }
}
