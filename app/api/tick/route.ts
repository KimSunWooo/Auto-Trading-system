import { tickAndGet } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const state = await tickAndGet();
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "엔진 틱에 실패했습니다." },
      { status: 500 },
    );
  }
}
