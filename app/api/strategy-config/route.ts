import { toPublic, mutateStore } from "@/lib/store";
import { ensureUniverseQuotes } from "@/lib/engine";
import { getRuleConfig, patchRuleConfig, saveRuleConfig, syncAllocationsToRules } from "@/src/rules/config";
import { EMPTY_RULE_CONFIG, blankRule } from "@/src/rules/params";

export const dynamic = "force-dynamic";

function errorResponse(err: unknown) {
  return Response.json(
    { error: err instanceof Error ? err.message : "사용자 설정을 저장하지 못했습니다." },
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
    config: getRuleConfig(),
    defaults: EMPTY_RULE_CONFIG,
    draft: blankRule({ ticker: "", enabled: false, budget: 0 }),
  });
}

export async function PUT(request: Request) {
  try {
    const config = saveRuleConfig(await readJson(request));
    const state = await mutateStore((current) =>
      ensureUniverseQuotes(syncAllocationsToRules(current, config.rules)),
    );
    return Response.json(toPublic(state));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const config = patchRuleConfig(await readJson(request));
    const state = await mutateStore((current) =>
      ensureUniverseQuotes(syncAllocationsToRules(current, config.rules)),
    );
    return Response.json(toPublic(state));
  } catch (err) {
    return errorResponse(err);
  }
}
