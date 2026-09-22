import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUserTradingRuntime(async (rt) => {
    const state = await rt.store.getPublicState(rt.rules.get());
    return Response.json(state);
  });
}
