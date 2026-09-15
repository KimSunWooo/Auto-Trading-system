import { toPublic, mutateStore } from "@/lib/store";
import { ensureUniverseQuotes } from "@/lib/engine";
import {
  commitRuleConfig,
  getRuleConfig,
  parseRuleConfig,
  syncAllocationsToRules,
} from "@/src/rules/config";
import { EMPTY_RULE_CONFIG, blankRule, overlayRuleConfig, validateRuleConfig } from "@/src/rules/params";

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
    const config = parseRuleConfig(await readJson(request));
    const state = await mutateStore((current) => {
      const synced = syncAllocationsToRules(current, config.rules);
      commitRuleConfig(config);
      return ensureUniverseQuotes(synced);
    });
    return Response.json(toPublic(state));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const overlay = overlayRuleConfig(getRuleConfig(), await readJson(request));
    const invalid = validateRuleConfig(overlay);
    if (invalid) throw new Error(invalid);
    const state = await mutateStore((current) => {
      const synced = syncAllocationsToRules(current, overlay.rules);
      commitRuleConfig(overlay);
      return ensureUniverseQuotes(synced);
    });
    return Response.json(toPublic(state));
  } catch (err) {
    return errorResponse(err);
  }
}
