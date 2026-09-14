import { tickAndGet } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  const state = await tickAndGet();
  return Response.json(state);
}
