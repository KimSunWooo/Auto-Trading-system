import { AllocationEngine } from "@/src/accounts/index";
import { mutateStore, toPublic } from "@/lib/store";
import type { Allocation } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    ruleId?: string;
    enabled?: boolean;
    budget?: number;
  };
  if (!body.ruleId) {
    return Response.json({ error: "룰 식별자가 필요합니다." }, { status: 400 });
  }
  try {
    const state = await mutateStore((current) =>
      AllocationEngine.patch(current, body.ruleId!, {
        enabled: body.enabled,
        budget: body.budget,
      }),
    );
    return Response.json(toPublic(state));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "배분을 바꾸지 못했습니다." },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    allocations?: Array<Pick<Allocation, "ruleId" | "budget"> & { enabled?: boolean }>;
  };
  if (!body.allocations?.length) {
    return Response.json({ error: "allocations 배열이 필요합니다." }, { status: 400 });
  }
  try {
    const state = await mutateStore((current) => AllocationEngine.rebalance(current, body.allocations!));
    return Response.json(toPublic(state));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "재배분에 실패했습니다." },
      { status: 400 },
    );
  }
}
