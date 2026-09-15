import { BacktestRunner } from "@/src/backtest/BacktestRunner";
import { DEFAULT_ALLOCATIONS, TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import { PLAYBOOKS, type PlaybookId } from "@/lib/playbooks";
import type { Allocation } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    years?: number;
    totalDeposit?: number;
    strategies?: PlaybookId[];
    allocations?: Allocation[];
  };
  const years = body.years === 1 ? 1 : 2;
  const totalDeposit = Math.max(100_000, Math.round(body.totalDeposit ?? TOTAL_DEPOSIT));
  const allocations =
    body.allocations?.length ? body.allocations : allocationsFromIds(body.strategies, totalDeposit);
  try {
    const result = await BacktestRunner.run({ years, totalDeposit, allocations });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "백테스트를 끝내지 못했습니다." },
      { status: 400 },
    );
  }
}

function allocationsFromIds(ids: PlaybookId[] | undefined, totalDeposit: number): Allocation[] {
  const selected = (ids?.length ? ids : PLAYBOOKS.map((row) => row.id)).filter(
    (id, i, all) => all.indexOf(id) === i,
  );
  if (selected.length === 1) {
    const book = PLAYBOOKS.find((row) => row.id === selected[0]) ?? PLAYBOOKS[0];
    return [
      {
        strategy: book.id,
        riskLevel: book.riskLevel,
        budget: totalDeposit,
        balance: totalDeposit,
        enabled: true,
      },
    ];
  }
  if (!ids?.length) {
    return DEFAULT_ALLOCATIONS.map((row) => ({
      ...row,
      budget: Math.round(row.budget * (totalDeposit / TOTAL_DEPOSIT)),
      balance: Math.round(row.balance * (totalDeposit / TOTAL_DEPOSIT)),
    }));
  }
  const even = Math.floor(totalDeposit / selected.length);
  return selected.map((id, index) => {
    const book = PLAYBOOKS.find((row) => row.id === id) ?? PLAYBOOKS[0];
    const budget = index === selected.length - 1 ? totalDeposit - even * (selected.length - 1) : even;
    return {
      strategy: book.id,
      riskLevel: book.riskLevel,
      budget,
      balance: budget,
      enabled: true,
    };
  });
}
