import { createInitialState } from "@/lib/engine";
import { mutateStore, toPublic } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  const state = await mutateStore(() => createInitialState());
  return Response.json(toPublic(state));
}
