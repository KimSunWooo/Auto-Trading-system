import { RiskManager } from "@/src/risk/RiskManager";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  return withUserTradingRuntime(async (rt) => {
    const rules = rt.rules.get();
    const state = await rt.store.mutateStore(async (current) => {
      const box = { current };
      await RiskManager.executeKillSwitch(box, {
        kis: rt.scope.kisClient,
        persistState: rt.scope.persistState,
      });
      return box.current;
    });
    return Response.json(rt.store.toPublic(state, rules));
  });
}
