import { AllocationEngine } from "@/src/accounts/index";
import type { Allocation } from "@/lib/types";
import { syncAllocationsToRules } from "@/src/rules/config";
import { validateAllocationPctSum, validateLegacyBudgetSum, readOrderableCashSnapshot } from "@/src/rules/allocation-ratio";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json()) as {
      ruleId?: string;
      enabled?: boolean;
      budget?: number;
      allocationPct?: number;
    };
    if (!body.ruleId) {
      return Response.json({ error: "룰 식별자가 필요합니다." }, { status: 400 });
    }
    if (body.budget !== undefined) {
      if (!Number.isFinite(body.budget) || body.budget < 0 || Number.isNaN(body.budget)) {
        return Response.json({ error: "예산이 올바르지 않습니다." }, { status: 400 });
      }
    }
    if (body.allocationPct !== undefined) {
      if (
        !Number.isFinite(body.allocationPct) ||
        body.allocationPct < 0 ||
        body.allocationPct > 1
      ) {
        return Response.json({ error: "배정 비율이 올바르지 않습니다." }, { status: 400 });
      }
    }
    try {
      const rules = rt.rules.get();
      let nextRules = rules.rules;
      if (body.allocationPct !== undefined || body.enabled !== undefined) {
        nextRules = rules.rules.map((r) => {
          if (r.id !== body.ruleId) return r;
          return {
            ...r,
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.allocationPct !== undefined
              ? {
                  allocationPct: body.allocationPct,
                  budgetMode: "orderable_ratio" as const,
                }
              : {}),
            ...(body.budget !== undefined ? { budget: body.budget } : {}),
          };
        });
        const pctErr = validateAllocationPctSum(nextRules);
        if (pctErr) throw new Error(pctErr);
      }

      const state = await rt.store.mutateStore(
        (current) => {
          let next = current;
          if (body.budget !== undefined || body.enabled !== undefined) {
            next = AllocationEngine.patch(next, body.ruleId!, {
              enabled: body.enabled,
              budget: body.budget,
            });
          }
          if (body.allocationPct !== undefined || body.enabled !== undefined) {
            next = syncAllocationsToRules(next, nextRules);
          }
          return next;
        },
        { durable: true, projectMode: "full" },
      );

      if (body.allocationPct !== undefined || (body.enabled !== undefined && nextRules !== rules.rules)) {
        rt.rules.commit({
          ...rules,
          rules: nextRules,
          version: (rules.version ?? 0) + 1,
        });
      }

      return Response.json(rt.store.toPublic(state, rt.rules.get()));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "배분을 바꾸지 못했습니다." },
        { status: 400 },
      );
    }
  });
}

export async function POST(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json()) as {
      allocations?: Array<Pick<Allocation, "ruleId" | "budget"> & { enabled?: boolean }>;
    };
    if (!body.allocations?.length) {
      return Response.json({ error: "allocations 배열이 필요합니다." }, { status: 400 });
    }
    for (const row of body.allocations) {
      if (!Number.isFinite(row.budget) || row.budget < 0) {
        return Response.json({ error: "예산이 올바르지 않습니다." }, { status: 400 });
      }
    }
    try {
      const rules = rt.rules.get();
      const state = await rt.store.getState();
      const snap = readOrderableCashSnapshot(state);
      const legacyErr = validateLegacyBudgetSum(
        body.allocations.map((row) => {
          const rule = rules.rules.find((r) => r.id === row.ruleId);
          return {
            ...(rule ?? {
              id: row.ruleId,
              name: row.ruleId,
              ticker: "000000",
              kind: "interval" as const,
              intervalMs: 60_000,
              fastMa: 5,
              slowMa: 20,
              buyPct: 0.1,
              sliceKrw: 100_000,
              minAmountKrw: 10_000,
              stopLossPct: 0.05,
              takeProfitPct: 0.03,
              enabled: row.enabled ?? true,
              budget: row.budget,
              budgetMode: "legacy_fixed" as const,
            }),
            budget: row.budget,
            enabled: row.enabled ?? true,
            budgetMode: "legacy_fixed" as const,
          };
        }),
        snap.depositCash ?? state.totalDeposit,
      );
      if (legacyErr) throw new Error(legacyErr);

      const next = await rt.store.mutateStore(
        (current) => AllocationEngine.rebalance(current, body.allocations!),
        { durable: true, projectMode: "full" },
      );
      return Response.json(rt.store.toPublic(next, rules));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "재배분에 실패했습니다." },
        { status: 400 },
      );
    }
  });
}
