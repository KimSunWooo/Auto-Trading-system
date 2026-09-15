import { getPublicState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getPublicState();
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "상태를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
