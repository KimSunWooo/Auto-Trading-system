import {
  resolveCurrentTradingRuntime,
  runtimeJsonError,
  type ResolvedTradingRuntime,
} from "@/src/runtime/resolve-trading-runtime";

export async function withUserTradingRuntime(
  handler: (rt: ResolvedTradingRuntime) => Promise<Response>,
): Promise<Response> {
  try {
    const rt = await resolveCurrentTradingRuntime();
    return await handler(rt);
  } catch (err) {
    return runtimeJsonError(err);
  }
}
