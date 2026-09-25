import { brokerPublicStatusFromKisClient, getBrokerPublicStatus } from "@/src/brokers/kis-config";
import {
  AccountNotConnectedError,
  resolveCurrentTradingRuntime,
  runtimeJsonError,
} from "@/src/runtime/resolve-trading-runtime";
import { AuthError } from "@/src/auth/guards";

export const dynamic = "force-dynamic";

/**
 * Prefer account-scoped RuntimeScope KisClient status for authenticated USER.
 * Unauthenticated / no-account callers get bootstrap env status (still KIS-only).
 */
export async function GET() {
  try {
    const rt = await resolveCurrentTradingRuntime();
    return Response.json(brokerPublicStatusFromKisClient(rt.scope.kisClient));
  } catch (err) {
    if (err instanceof AuthError || err instanceof AccountNotConnectedError) {
      return Response.json(getBrokerPublicStatus());
    }
    return runtimeJsonError(err);
  }
}
