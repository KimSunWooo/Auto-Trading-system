import { AllocationEngine } from "@/src/accounts/index";
import { mutateStore, toPublic } from "@/lib/store";
import { PLAYBOOKS, type PlaybookId } from "@/lib/playbooks";
import { TOTAL_DEPOSIT } from "@/src/accounts/defaults";
import type { Allocation } from "@/lib/types";
import { resetCircuit } from "@/src/risk/circuit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    totalDeposit?: number;
    strategies?: PlaybookId[];
    autoStart?: boolean;
  };
  const totalDeposit = Math.max(100_000, Math.round(body.totalDeposit ?? TOTAL_DEPOSIT));
  const ids = (body.strategies?.length ? body.strategies : ["Level1_Stable", "Level10_Aggressive"]) as PlaybookId[];
  const allocations = splitAllocations(ids, totalDeposit);
  try {
    const state = await mutateStore((current) => {
      let next = AllocationEngine.rebalance(
        { ...current, totalDeposit },
        allocations,
      );
      next = {
        ...next,
        totalDeposit,
        settings: {
          ...next.settings,
          startingCash: totalDeposit,
          autoTrading: Boolean(body.autoStart),
          onboardingComplete: true,
        },
        dayStart: { date: "", equity: totalDeposit },
        equityHistory: [totalDeposit],
      };
      if (body.autoStart && next.circuit.halted && next.circuit.kind === "kill") {
        const reset = resetCircuit(next);
        if (!reset.error) next = { ...reset.state, settings: next.settings };
      }
      return next;
    });
    return Response.json(toPublic(state));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "온보딩을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}

function splitAllocations(ids: PlaybookId[], totalDeposit: number): Allocation[] {
  const unique = ids.filter((id, i, all) => all.indexOf(id) === i);
  if (unique.length === 1) {
    const book = PLAYBOOKS.find((row) => row.id === unique[0]) ?? PLAYBOOKS[0];
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
  if (unique.includes("Level1_Stable") && unique.includes("Level10_Aggressive") && unique.length === 2) {
    const stable = Math.round(totalDeposit * 0.7);
    return [
      {
        strategy: "Level1_Stable",
        riskLevel: 1,
        budget: stable,
        balance: stable,
        enabled: true,
      },
      {
        strategy: "Level10_Aggressive",
        riskLevel: 10,
        budget: totalDeposit - stable,
        balance: totalDeposit - stable,
        enabled: true,
      },
    ];
  }
  const even = Math.floor(totalDeposit / unique.length);
  return unique.map((id, index) => {
    const book = PLAYBOOKS.find((row) => row.id === id) ?? PLAYBOOKS[0];
    const budget = index === unique.length - 1 ? totalDeposit - even * (unique.length - 1) : even;
    return {
      strategy: book.id,
      riskLevel: book.riskLevel,
      budget,
      balance: budget,
      enabled: true,
    };
  });
}
