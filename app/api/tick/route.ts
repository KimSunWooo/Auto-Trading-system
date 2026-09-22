import { httpTickAllowed } from "@/src/runtime/trading-mode";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import { isScopeStartupSyncDone } from "@/src/runtime/runtime-scope";

export const dynamic = "force-dynamic";

export async function POST() {
  return withUserTradingRuntime(async (rt) => {
    const rules = rt.rules.get();
    try {
      if (!httpTickAllowed()) {
        const state = await rt.store.getPublicState(rules);
        return Response.json(state);
      }
      const state = await rt.store.tickAndGet(rules, {
        source: "http",
        tickDeps: {
          kisClient: rt.scope.kisClient,
          persistState: rt.scope.persistState,
          ruleConfig: rules,
          startupSyncVerified: isScopeStartupSyncDone(rt.account.id),
          workerLockPath: rt.scope.lockPath,
          quoteHub: rt.scope.quoteHub,
          quoteConsumerId: rt.scope.brokerAccountId,
        },
      });
      return Response.json(state);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "엔진 틱에 실패했습니다." },
        { status: 500 },
      );
    }
  });
}
