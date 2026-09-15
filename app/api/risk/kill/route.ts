import { mutateStore, toPublic } from "@/lib/store";
import { RiskManager } from "@/src/risk/RiskManager";

export const dynamic = "force-dynamic";

export async function POST() {
  const state = await mutateStore(async (current) => {
    const box = { current };
    await RiskManager.executeKillSwitch(box);
    return box.current;
  });
  return Response.json(toPublic(state));
}
