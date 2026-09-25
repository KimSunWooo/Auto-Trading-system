import { ensureUniverseQuotes } from "@/lib/engine";
import { parseRuleConfig, syncAllocationsToRules } from "@/src/rules/config";
import { parseUserRule, DISCLAIMER_TEXT } from "@/src/rules/params";
import { resetCircuit } from "@/src/risk/circuit";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import { paperBalanceReadyForOnboarding } from "@/src/runtime/paper-broker-baseline";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json()) as {
      totalDeposit?: number;
      rule?: unknown;
      autoStart?: boolean;
      disclaimerAccepted?: boolean;
    };
    if (body.autoStart && !body.disclaimerAccepted) {
      return Response.json(
        { error: "이용 동의 전에는 자동 실행을 켤 수 없습니다.", disclaimer: DISCLAIMER_TEXT },
        { status: 400 },
      );
    }

    const current = await rt.store.getState();
    const notReady = paperBalanceReadyForOnboarding(current);
    if (notReady) {
      return Response.json(
        { error: notReady, code: "PAPER_BALANCE_NOT_READY" },
        { status: 409 },
      );
    }

    // Client totalDeposit is ignored — KIS broker baseline is authority.
    const rule = body.rule ? parseUserRule(body.rule) : null;
    if (body.rule && !rule) {
      return Response.json({ error: "종목코드 6자리와 조건을 입력하세요." }, { status: 400 });
    }
    try {
      const config = parseRuleConfig({ rules: rule ? [rule] : [] });
      const state = await rt.store.mutateStore((prev) => {
        let next = syncAllocationsToRules(
          {
            ...prev,
            settings: {
              ...prev.settings,
              broker: "kis",
              autoTrading: Boolean(body.autoStart) && Boolean(body.disclaimerAccepted),
              onboardingComplete: true,
              disclaimerAccepted: Boolean(body.disclaimerAccepted),
              disclaimerAcceptedAt: body.disclaimerAccepted
                ? new Date().toISOString()
                : prev.settings.disclaimerAcceptedAt,
            },
          },
          config.rules,
        );
        if (body.autoStart && next.circuit.halted && next.circuit.kind === "kill") {
          const reset = resetCircuit(next);
          if (!reset.error) next = { ...reset.state, settings: next.settings };
        }
        rt.rules.commit(config);
        return ensureUniverseQuotes(next);
      });
      return Response.json(rt.store.toPublic(state, config));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "설정을 저장하지 못했습니다." },
        { status: 400 },
      );
    }
  });
}
