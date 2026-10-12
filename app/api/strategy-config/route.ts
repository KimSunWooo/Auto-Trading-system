import { ensureUniverseQuotes } from "@/lib/engine";
import { parseRuleConfig, syncAllocationsToRules } from "@/src/rules/config";
import {
  EMPTY_RULE_CONFIG,
  blankRule,
  overlayRuleConfig,
  validateRuleConfig,
  type RuleConfigFile,
} from "@/src/rules/params";
import {
  convertLegacyToRatio,
  readOrderableCashSnapshot,
  strategyBudgetView,
  sumActiveAllocationPct,
} from "@/src/rules/allocation-ratio";
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

function assertVersion(current: RuleConfigFile, incoming: RuleConfigFile): void {
  if (incoming.version == null || current.version == null) return;
  if (incoming.version !== current.version) {
    throw new Error(
      `설정 버전이 충돌합니다 (client=${incoming.version}, server=${current.version}). 새로고침 후 다시 저장하세요.`,
    );
  }
}

function bumpVersion(prev: RuleConfigFile, next: RuleConfigFile): RuleConfigFile {
  return {
    ...next,
    version: (prev.version ?? 0) + 1,
  };
}

export async function GET() {
  return withUserTradingRuntime(async (rt) => {
    const config = rt.rules.get();
    const state = await rt.store.getState();
    const orderable = readOrderableCashSnapshot(state);
    const views = config.rules.map((rule) => strategyBudgetView(state, rule));
    return Response.json({
      config,
      defaults: EMPTY_RULE_CONFIG,
      draft: blankRule({
        ticker: "",
        enabled: false,
        budget: 0,
        budgetMode: "orderable_ratio",
        allocationPct: 0,
      }),
      budgetPreview: {
        orderableCash: orderable.orderableCash,
        depositCash: orderable.depositCash,
        freshness: orderable.freshness,
        fetchedAtMs: orderable.fetchedAtMs,
        reason: orderable.reason,
        activeAllocationPctSum: sumActiveAllocationPct(config.rules),
        remainingAllocationPct: Math.max(0, 1 - sumActiveAllocationPct(config.rules)),
        strategies: views,
        autoTradingEnabled: state.settings.autoTrading === true,
        evaluationContinuesWhileOrdersBlocked: state.settings.autoTrading !== true,
      },
    });
  });
}

export async function PUT(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    try {
      const current = rt.rules.get();
      const parsed = parseRuleConfig(await readJson(request));
      assertVersion(current, parsed);
      const invalid = validateRuleConfig(parsed);
      if (invalid) throw new Error(invalid);
      const config = bumpVersion(current, parsed);

      // Durable ledger first (rules+allocations); then strategy file (rules SoT).
      const state = await rt.store.mutateStore(
        (currentState) => {
          const synced = syncAllocationsToRules(currentState, config.rules);
          return ensureUniverseQuotes(synced);
        },
        { durable: true, projectMode: "full" },
      );
      try {
        rt.rules.commit(config);
      } catch (err) {
        throw new Error(
          `장부는 저장됐으나 전략 파일 커밋 실패: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
      return Response.json(rt.store.toPublic(state, config));
    } catch (err) {
      return errorResponse(err);
    }
  });
}

export async function PATCH(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    try {
      const body = await readJson(request);
      const current = rt.rules.get();

      // Explicit legacy → ratio conversion (does not enable autoTrading).
      if (body && typeof body === "object" && (body as { action?: string }).action === "convert_legacy_to_ratio") {
        const ruleId = String((body as { ruleId?: string }).ruleId ?? "");
        const state = await rt.store.getState();
        const snap = readOrderableCashSnapshot(state);
        const rule = current.rules.find((r) => r.id === ruleId);
        if (!rule) throw new Error("전환할 전략을 찾을 수 없습니다.");
        const converted = convertLegacyToRatio(rule.budget, snap.orderableCash);
        if ("error" in converted) throw new Error(converted.error);
        const nextRules = current.rules.map((r) =>
          r.id === ruleId
            ? {
                ...r,
                budgetMode: "orderable_ratio" as const,
                allocationPct: converted.allocationPct,
                // Keep legacy budget for audit; ratio is authoritative.
                budget: r.budget,
              }
            : r,
        );
        const overlay = { rules: nextRules, version: current.version };
        const invalid = validateRuleConfig(overlay);
        if (invalid) throw new Error(invalid);
        const config = bumpVersion(current, overlay);
        const nextState = await rt.store.mutateStore(
          (currentState) => {
            const synced = syncAllocationsToRules(currentState, config.rules);
            return ensureUniverseQuotes(synced);
          },
          { durable: true, projectMode: "full" },
        );
        rt.rules.commit(config);
        return Response.json({
          ...rt.store.toPublic(nextState, config),
          conversion: {
            ruleId,
            allocationPct: converted.allocationPct,
            computedCashLimit: converted.computedCashLimit,
            orderableCash: snap.orderableCash,
          },
        });
      }

      const overlay = overlayRuleConfig(current, body);
      assertVersion(current, overlay);
      const invalid = validateRuleConfig(overlay);
      if (invalid) throw new Error(invalid);
      const config = bumpVersion(current, overlay);

      const state = await rt.store.mutateStore(
        (currentState) => {
          const synced = syncAllocationsToRules(currentState, config.rules);
          return ensureUniverseQuotes(synced);
        },
        { durable: true, projectMode: "full" },
      );
      try {
        rt.rules.commit(config);
      } catch (err) {
        throw new Error(
          `장부는 저장됐으나 전략 파일 커밋 실패: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
      return Response.json(rt.store.toPublic(state, config));
    } catch (err) {
      return errorResponse(err);
    }
  });
}
