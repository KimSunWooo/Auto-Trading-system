import { nowIso, nowMs } from "@/src/clock";
import type { AccountBucket } from "@/src/accounts/AccountBucket";
import type { IBroker } from "@/src/brokers/IBroker";
import { sma } from "@/src/strategies/indicators";
import { findStock } from "@/lib/universe";
import type { UserRule } from "@/src/rules/params";
import { makeSignalId } from "@/src/runtime/intents";
import { seoulDay } from "@/src/risk/limits";

export class RuleRunner {
  static async execute(broker: IBroker, bucket: AccountBucket, rule: UserRule): Promise<AccountBucket> {
    if (rule.kind === "ma-cross") return runMaCross(broker, bucket, rule);
    return runInterval(broker, bucket, rule);
  }
}

async function runInterval(
  broker: IBroker,
  bucket: AccountBucket,
  rule: UserRule,
): Promise<AccountBucket> {
  const now = nowMs();
  const last = bucket.lastRunAt ? new Date(bucket.lastRunAt).getTime() : 0;
  if (now - last < rule.intervalMs) {
    return { ...bucket, lastMessage: "실행 주기 대기 중" };
  }
  const amount = Math.min(rule.sliceKrw, Math.floor(bucket.balance * rule.buyPct));
  if (amount < rule.minAmountKrw) {
    return { ...bucket, lastMessage: "예수금이 적어 이번 주기를 건너뜁니다." };
  }
  const signalId = makeSignalId(["sig", "interval", rule.id, rule.ticker, Math.floor(now / Math.max(1, rule.intervalMs))]);
  const fill = await broker.withIntent({ intentId: signalId, signalId, reason: "interval-buy" }).buyMarket(rule.ticker, amount);
  const name = findStock(rule.ticker)?.name ?? rule.ticker;
  return {
    ...bucket,
    lastRunAt: new Date(now).toISOString(),
    lastMessage: fill.ok
      ? `${name} ${fill.qty}주 조건 매수 (${fill.net.toLocaleString("ko-KR")}원)`
      : fill.status === "pending"
        ? `${name} ${fill.qty}주 주문 접수 (체결 대기)`
        : fill.reason ?? "조건 매수 실패",
  };
}

async function runMaCross(
  broker: IBroker,
  bucket: AccountBucket,
  rule: UserRule,
): Promise<AccountBucket> {
  const quote = await broker.getQuote(rule.ticker);
  if (!quote) return { ...bucket, lastMessage: "시세 없음" };
  const fast = sma(quote.history, rule.fastMa);
  const slow = sma(quote.history, rule.slowMa);
  if (fast == null || slow == null) {
    return { ...bucket, lastMessage: "이동평균 워밍업 중" };
  }
  const regime = String(bucket.meta.regime ?? "flat");
  const held = bucket.positions.find((p) => p.code === rule.ticker);
  const name = findStock(rule.ticker)?.name ?? rule.ticker;

  if (fast > slow && regime !== "long") {
    const amount = Math.min(rule.sliceKrw, Math.floor(bucket.balance * rule.buyPct));
    const signalId = makeSignalId(["sig", "ma", rule.id, rule.ticker, "long", seoulDay()]);
    const fill = await broker.withIntent({ intentId: signalId, signalId, reason: "ma-buy" }).buyMarket(rule.ticker, amount);
    return {
      ...bucket,
      lastRunAt: nowIso(),
      lastMessage: fill.ok
        ? `이평 상향 돌파 매수 ${fill.qty}주`
        : fill.status === "pending"
          ? `이평 상향 돌파 주문 접수 (${fill.qty}주)`
          : fill.reason ?? "매수 실패",
      meta: {
        ...bucket.meta,
        regime: fill.ok ? "long" : fill.status === "unknown" ? "halt" : regime,
      },
    };
  }

  if (fast < slow && regime === "long" && held && held.qty > 0) {
    const signalId = makeSignalId(["sig", "ma", rule.id, rule.ticker, "exit", seoulDay()]);
    const fill = await broker.withIntent({ intentId: signalId, signalId, reason: "ma-sell" }).sellMarket(rule.ticker, held.qty);
    return {
      ...bucket,
      lastRunAt: nowIso(),
      lastMessage: fill.ok ? `이평 하향 이탈 매도 ${fill.qty}주` : fill.reason ?? "매도 실패",
      meta: { ...bucket.meta, regime: fill.ok ? "flat" : regime },
    };
  }

  return {
    ...bucket,
    lastMessage: `대기 (${name} MA${rule.fastMa} ${Math.round(fast)} / MA${rule.slowMa} ${Math.round(slow)})`,
  };
}
