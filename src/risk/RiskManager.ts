import { nowIso } from "@/src/clock";
import { portfolioValue } from "@/src/accounts/portfolio";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker } from "@/src/brokers/index";
import type { AppState, Side } from "@/lib/types";
import { seoulDay } from "@/src/risk/limits";
import { openCircuit, resetCircuit } from "@/src/risk/circuit";
import { DEFAULT_PRODUCT_RISK, type ProductRisk } from "@/src/risk/product";

function riskOf(state: AppState): ProductRisk {
  return state.settings?.risk ?? DEFAULT_PRODUCT_RISK;
}

export class RiskManager {
  constructor(private readonly box: StateBox) {}

  static rollDay(state: AppState, now = new Date()): AppState {
    const today = seoulDay(now);
    if (state.dayStart?.date === today && state.dayStart.equity > 0) return state;
    let next = state;
    if (state.circuit?.halted && state.circuit.kind === "daily-loss") {
      const reset = resetCircuit(state);
      if (!reset.error) next = reset.state;
    }
    return {
      ...next,
      dayStart: { date: today, equity: Math.max(1, portfolioValue(next)) },
    };
  }

  static checkDailyLoss(state: AppState): AppState {
    const marked = RiskManager.rollDay(state);
    if (marked.circuit?.halted) return marked;
    const start = marked.dayStart.equity;
    const equity = portfolioValue(marked);
    const lossPct = (start - equity) / start;
    const cap = riskOf(marked).dailyLossPct;
    if (lossPct + 1e-12 >= cap) {
      return openCircuit(
        marked,
        `일일 최대 손실 ${Math.round(cap * 100)}%에 도달해 당일 자동매매를 멈췄습니다.`,
        undefined,
        "daily-loss",
      );
    }
    return marked;
  }

  static checkBuy(
    state: AppState,
    input: { side: Side; ticker: string; qty: number; price: number },
  ): string | null {
    if (input.side !== "buy") return null;
    const cap = riskOf(state).maxTickerWeight;
    const quote = state.quotes[input.ticker];
    const last = quote?.price ?? input.price;
    const held =
      state.positions.filter((p) => p.code === input.ticker).reduce((sum, p) => sum + p.qty, 0) +
      input.qty;
    const denom = Math.max(1, state.totalDeposit);
    if ((held * last) / denom > cap + 1e-12) {
      return `종목 투자 비중 ${Math.round(cap * 100)}%를 넘을 수 없습니다.`;
    }
    return null;
  }

  static shouldStopLoss(avgPrice: number, last: number, stopLossPct: number): boolean {
    if (avgPrice <= 0 || last <= 0) return false;
    return (last - avgPrice) / avgPrice <= -stopLossPct;
  }

  static stopAllTrading(state: AppState): AppState {
    const halted = openCircuit(state, "긴급 정지로 자동매매를 멈췄습니다.", undefined, "kill");
    return {
      ...halted,
      settings: {
        ...halted.settings,
        autoTrading: false,
      },
      allocations: halted.allocations.map((row) => ({
        ...row,
        enabled: false,
        lastMessage: "긴급 정지",
      })),
      conditions: halted.conditions.map((cond) =>
        cond.watching
          ? { ...cond, watching: false, status: "paused" as const, message: "긴급 정지" }
          : cond,
      ),
      dcaPlans: halted.dcaPlans.map((plan) => ({
        ...plan,
        enabled: false,
        lastMessage: "긴급 정지",
      })),
      orders: halted.orders.map((order) =>
        order.status === "pending" && !order.brokerOrderNo
          ? { ...order, status: "cancelled" as const, reason: "긴급 정지" }
          : order,
      ),
    };
  }

  async enforceStopLoss(): Promise<void> {
    const state = this.box.current;
    if (!state.settings.autoTrading) return;
    if (state.circuit?.kind === "kill" || state.circuit?.kind === "unknown") return;
    const pct = riskOf(state).stopLossPct;
    const root = createBroker(this.box);
    const snapshot = [...state.positions];
    for (const pos of snapshot) {
      if (pos.qty < 1) continue;
      const quote = this.box.current.quotes[pos.code];
      const last = quote?.price ?? pos.avgPrice;
      if (!RiskManager.shouldStopLoss(pos.avgPrice, last, pct)) continue;
      await root.forStrategy(pos.strategy).sellMarket(pos.code, pos.qty);
      this.box.current = {
        ...this.box.current,
        allocations: this.box.current.allocations.map((row) =>
          row.strategy === pos.strategy
            ? {
                ...row,
                lastMessage: `${pos.name} 손절 (${Math.round(pct * 100)}%, 평단 대비)`,
                lastRunAt: nowIso(),
              }
            : row,
        ),
      };
    }
  }
}
