import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { getRuleConfig, syncAllocationsToRules } from "@/src/rules/config";
import { createInitialState } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      years?: number;
      totalDeposit?: number;
    };
    const years = body.years === 1 ? 1 : 2;
    const totalDeposit = Math.max(100_000, Math.round(body.totalDeposit ?? TOTAL_DEPOSIT));
    const rules = getRuleConfig().rules;
    if (rules.length === 0) {
      return Response.json({
        years,
        ruleIds: [],
        metrics: {
          startEquity: totalDeposit,
          endEquity: totalDeposit,
          totalReturnPct: 0,
          mddPct: 0,
          trades: 0,
          winRatePct: null,
          avgWin: null,
          avgLoss: null,
          wins: 0,
          losses: 0,
        },
        equityCurve: [{ t: Date.now(), equity: totalDeposit }],
        tradeLog: [],
      });
    }
    const seed = syncAllocationsToRules({ ...createInitialState(), totalDeposit }, rules);
    const result = await BacktestRunner.run({
      years,
      totalDeposit,
      allocations: seed.allocations.filter((row) => row.ruleId !== "cash"),
    });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "조건 재생을 끝내지 못했습니다." },
      { status: 400 },
    );
  }
}
