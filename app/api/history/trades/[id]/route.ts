import { getTradeById } from "@/src/db/repositories/history";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const trade = await getTradeById(id);
  if (!trade) {
    return Response.json({ error: "trade not found" }, { status: 404 });
  }
  return Response.json(trade);
}
