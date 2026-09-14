import { mutateStore, toPublic } from "@/lib/store";
import { resetCircuit } from "@/src/risk/circuit";

export const dynamic = "force-dynamic";

export async function POST() {
  let error: string | undefined;
  const state = await mutateStore((current) => {
    const next = resetCircuit(current);
    error = next.error;
    return next.state;
  });
  if (error) {
    return Response.json({ error, ...toPublic(state) }, { status: 409 });
  }
  return Response.json(toPublic(state));
}
