import { resetCircuit } from "@/src/risk/circuit";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  return withUserTradingRuntime(async (rt) => {
    let error: string | undefined;
    const rules = rt.rules.get();
    const state = await rt.store.mutateStore((current) => {
      const next = resetCircuit(current);
      error = next.error;
      return next.state;
    });
    if (error) {
      return Response.json({ error, ...rt.store.toPublic(state, rules) }, { status: 409 });
    }
    return Response.json(rt.store.toPublic(state, rules));
  });
}
