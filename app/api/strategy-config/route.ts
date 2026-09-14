import { toPublic, withStore } from "@/lib/store";
import { getStrategyConfig, saveStrategyConfig } from "@/src/strategies/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getStrategyConfig());
}

export async function PUT(request: Request) {
  const body = (await request.json()) as unknown;
  try {
    saveStrategyConfig(body);
    const state = await withStore((current) => toPublic(current));
    return Response.json(state);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "전략 설정을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
