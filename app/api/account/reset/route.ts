import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import { usesPaperBrokerBalanceSemantics } from "@/src/risk/kis-balance-semantics";
import { createInitialState } from "@/lib/engine";
import { createPaperAccountResetState } from "@/src/runtime/paper-broker-baseline";
import { markScopeStartupSyncDone } from "@/src/runtime/runtime-scope";

export const dynamic = "force-dynamic";

export async function POST() {
  return withUserTradingRuntime(async (rt) => {
    const rules = rt.rules.get();
    const paper = usesPaperBrokerBalanceSemantics();
    const state = await rt.store.mutateStore(() =>
      paper ? createPaperAccountResetState() : createInitialState(),
    );
    if (paper) {
      markScopeStartupSyncDone(rt.account.id, false);
    }
    return Response.json(rt.store.toPublic(state, rules));
  });
}
