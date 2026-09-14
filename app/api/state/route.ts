import { getPublicState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await getPublicState();
  return Response.json(state);
}
