import { createInitialState } from "@/lib/engine";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  return withUserTradingRuntime(async (rt) => {
    const rules = rt.rules.get();
    const state = await rt.store.mutateStore(() => createInitialState());
    return Response.json(rt.store.toPublic(state, rules));
  });
}
