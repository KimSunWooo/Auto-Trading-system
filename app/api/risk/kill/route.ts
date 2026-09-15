import { mutateStore, toPublic } from "@/lib/store";
import { RiskManager } from "@/src/risk/RiskManager";

export const dynamic = "force-dynamic";

export async function POST() {
  const state = await mutateStore((current) => RiskManager.stopAllTrading(current));
  return Response.json(toPublic(state));
}
