import type { Allocation, AppState, Order } from "@/lib/types";
import { createInitialQuotes, createInitialState } from "@/lib/engine";
import { cashFromAllocations } from "@/src/accounts/defaults";
import { accountValue } from "@/src/accounts/portfolio";
import { withNow } from "@/src/clock";
import { QuantEngine } from "@/src/engine/QuantEngine";
import { tradingBlocked } from "@/src/risk/circuit";
import { RiskManager } from "@/src/risk/RiskManager";
import {
  generateDailyCandles,
  quoteFromCandle,
  watchedBacktestTickers,
  type Candle,
} from "@/src/backtest/candles";

export type BacktestTrade = {
  at: string;
  side: Order["side"];
  code: string;
  name: string;
  qty: number;
  price: number;
  ruleId?: string;
  realizedPnl?: number;
};

export type EquityPoint = { t: number; equity: number };

export type BacktestMetrics = {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  mddPct: number;
  trades: number;
  winRatePct: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  wins: number;
  losses: number;
};

export type BacktestResult = {
  years: number;
  ruleIds: string[];
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  tradeLog: BacktestTrade[];
};

export type BacktestInput = {
  years?: number;
  totalDeposit: number;
  allocations: Allocation[];
  candles?: Record<string, Candle[]>;
};

function emptyMetrics(startEquity: number): BacktestMetrics {
  return {
    startEquity,
    endEquity: startEquity,
    totalReturnPct: 0,
    mddPct: 0,
    trades: 0,
    winRatePct: null,
    avgWin: null,
    avgLoss: null,
    wins: 0,
    losses: 0,
  };
}

function metricsFrom(curve: EquityPoint[], sells: BacktestTrade[]): BacktestMetrics {
  const startEquity = curve[0]?.equity ?? 0;
  const endEquity = curve[curve.length - 1]?.equity ?? startEquity;
  let peak = startEquity;
  let mdd = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) mdd = Math.max(mdd, (peak - point.equity) / peak);
  }
  const closed = sells.filter((row) => row.realizedPnl != null);
  const wins = closed.filter((row) => (row.realizedPnl ?? 0) > 0);
  const losses = closed.filter((row) => (row.realizedPnl ?? 0) < 0);
  const avg = (rows: BacktestTrade[]) =>
    rows.length ? Math.round(rows.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0) / rows.length) : null;
  return {
    startEquity,
    endEquity,
    totalReturnPct: startEquity > 0 ? ((endEquity - startEquity) / startEquity) * 100 : 0,
    mddPct: mdd * 100,
    trades: sells.length > 0 ? sells.length : closed.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    wins: wins.length,
    losses: losses.length,
  };
}

function applyDay(state: AppState, candles: Record<string, Candle[]>, index: number): AppState {
  const quotes = { ...state.quotes };
  for (const [ticker, series] of Object.entries(candles)) {
    const candle = series[index];
    if (!candle) continue;
    const prev = index > 0 ? series[index - 1].close : candle.open;
    const history = series.slice(Math.max(0, index - 79), index).map((row) => row.close);
    quotes[ticker] = quoteFromCandle(candle, prev, history);
  }
  return { ...state, quotes };
}

export class BacktestRunner {
  static async run(input: BacktestInput): Promise<BacktestResult> {
    const years = input.years === 1 ? 1 : 2;
    const tickers = watchedBacktestTickers();
    const ruleIds = input.allocations.filter((row) => row.enabled && row.ruleId !== "cash").map((row) => row.ruleId);
    if (tickers.length === 0) {
      return {
        years,
        ruleIds,
        metrics: emptyMetrics(input.totalDeposit),
        equityCurve: [{ t: Date.now(), equity: input.totalDeposit }],
        tradeLog: [],
      };
    }
    const candles = input.candles ?? generateDailyCandles(tickers, years);
    const sample = Object.values(candles)[0] ?? [];
    const allocations = input.allocations.map((row) => ({
      ...row,
      balance: row.budget,
      enabled: row.enabled ?? true,
      meta: {},
    }));

    let state: AppState = {
      ...createInitialState(),
      settings: {
        ...createInitialState().settings,
        autoTrading: true,
        disclaimerAccepted: true,
        ignoreMarketHours: true,
        startingCash: input.totalDeposit,
      },
      totalDeposit: input.totalDeposit,
      allocations,
      cash: cashFromAllocations(allocations),
      positions: [],
      orders: [],
      quotes: { ...createInitialQuotes(), ...applyDay(createInitialState(), candles, 0).quotes },
      dayStart: { date: "", equity: input.totalDeposit },
      equityHistory: [input.totalDeposit],
    };

    const curve: EquityPoint[] = [{ t: sample[0]?.t ?? Date.now(), equity: input.totalDeposit }];

    for (let i = 0; i < sample.length; i++) {
      const t = sample[i].t;
      await withNow(t, async () => {
        state = RiskManager.rollDay(state, new Date(t));
        state = applyDay(state, candles, i);
        const box = { current: state };
        await new RiskManager(box).enforceStops();
        box.current = RiskManager.checkDailyLoss(box.current);
        if (box.current.settings.autoTrading && box.current.settings.disclaimerAccepted && !tradingBlocked(box.current)) {
          box.current = await QuantEngine.run(box.current);
        }
        state = box.current;
      });
      curve.push({ t, equity: accountValue(state) });
    }

    const tradeLog: BacktestTrade[] = state.orders
      .filter((order) => order.status === "filled" && !order.parentOrderId)
      .slice()
      .reverse()
      .map((order) => ({
        at: order.createdAt,
        side: order.side,
        code: order.code,
        name: order.name,
        qty: order.qty,
        price: order.price,
        ruleId: order.ruleId,
        realizedPnl: order.realizedPnl,
      }));

    const sells = tradeLog.filter((row) => row.side === "sell");
    const filledCount = tradeLog.length;
    const computed = metricsFrom(curve, sells);
    computed.trades = filledCount;

    return {
      years,
      ruleIds,
      metrics: computed,
      equityCurve: curve.filter((_, i) => i % Math.max(1, Math.floor(curve.length / 120)) === 0 || i === curve.length - 1),
      tradeLog: tradeLog.slice(0, 40),
    };
  }
}
