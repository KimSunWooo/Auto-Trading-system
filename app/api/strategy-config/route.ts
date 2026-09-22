import { ensureUniverseQuotes } from "@/lib/engine";
import { parseRuleConfig, syncAllocationsToRules } from "@/src/rules/config";
import { EMPTY_RULE_CONFIG, blankRule, overlayRuleConfig, validateRuleConfig } from "@/src/rules/params";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";

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
  return withUserTradingRuntime(async (rt) => {
    return Response.json({
      config: rt.rules.get(),
      defaults: EMPTY_RULE_CONFIG,
      draft: blankRule({ ticker: "", enabled: false, budget: 0 }),
    });
  });
}

export async function PUT(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    try {
      const config = parseRuleConfig(await readJson(request));
      const state = await rt.store.mutateStore((current) => {
        const synced = syncAllocationsToRules(current, config.rules);
        rt.rules.commit(config);
        return ensureUniverseQuotes(synced);
      });
      return Response.json(rt.store.toPublic(state, config));
    } catch (err) {
      return errorResponse(err);
    }
  });
}

export async function PATCH(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    try {
      const overlay = overlayRuleConfig(rt.rules.get(), await readJson(request));
      const invalid = validateRuleConfig(overlay);
      if (invalid) throw new Error(invalid);
      const state = await rt.store.mutateStore((current) => {
        const synced = syncAllocationsToRules(current, overlay.rules);
        rt.rules.commit(overlay);
        return ensureUniverseQuotes(synced);
      });
      return Response.json(rt.store.toPublic(state, overlay));
    } catch (err) {
      return errorResponse(err);
    }
  });
}
