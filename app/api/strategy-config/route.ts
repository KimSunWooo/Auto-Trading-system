import { toPublic, withStore } from "@/lib/store";
import {
  getStrategyConfig,
  patchStrategyConfig,
  saveStrategyConfig,
} from "@/src/strategies/config";
import { DEFAULT_STRATEGY_CONFIG } from "@/src/strategies/params";

export const dynamic = "force-dynamic";

function errorResponse(err: unknown) {
  return Response.json(
    { error: err instanceof Error ? err.message : "전략 설정을 저장하지 못했습니다." },
    { status: 400 },
  );
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("JSON 본문이 필요합니다.");
  }
}

export async function GET() {
  return Response.json({
    config: getStrategyConfig(),
    defaults: DEFAULT_STRATEGY_CONFIG,
  });
}

export async function PUT(request: Request) {
  try {
    saveStrategyConfig(await readJson(request));
    const state = await withStore((current) => toPublic(current));
    return Response.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    patchStrategyConfig(await readJson(request));
    const state = await withStore((current) => toPublic(current));
    return Response.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}
