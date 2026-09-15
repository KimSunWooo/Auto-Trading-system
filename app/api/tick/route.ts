import { getPublicState, tickAndGet } from "@/lib/store";
import { httpTickAllowed } from "@/src/runtime/trading-mode";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    if (!httpTickAllowed()) {
      const state = await getPublicState();
      return Response.json(state);
    }
    const state = await tickAndGet({ source: "http" });
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "엔진 틱에 실패했습니다." },
      { status: 500 },
    );
  }
}
