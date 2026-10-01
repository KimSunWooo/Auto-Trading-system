import { mergeProductRisk } from "@/src/risk/product";
import { resetCircuit } from "@/src/risk/circuit";
import { DISCLAIMER_TEXT } from "@/src/rules/params";
import type { AppState } from "@/lib/types";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import {
  assertReadyToEnablePaperAutoTrading,
  runPaperTradingPreflightForUser,
} from "@/src/runtime/paper-trading-preflight";
import { isScopeStartupSyncDone } from "@/src/runtime/runtime-scope";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json()) as {
      ignoreMarketHours?: boolean;
      autoTrading?: boolean;
      onboardingComplete?: boolean;
      disclaimerAccepted?: boolean;
      risk?: unknown;
    };
    try {
      const rules = rt.rules.get();

      // Enabling autoTrading requires PAPER preflight HEALTHY — never REAL.
      if (body.autoTrading === true) {
        const state = await rt.store.getState();
        const preflight = await runPaperTradingPreflightForUser({
          userId: rt.user.id,
          state,
          workerLockPath: rt.scope.lockPath,
          bootStartupVerified: isScopeStartupSyncDone(rt.account.id),
          probeKisAuth: true,
        });
        const blocked = assertReadyToEnablePaperAutoTrading(preflight);
        if (blocked) {
          return Response.json(
            {
              error: blocked,
              code: "PAPER_PREFLIGHT_NOT_READY",
              readyForPaperAutoTrading: false,
              blockers: preflight.blockers,
            },
            { status: 409 },
          );
        }
      }

      const state = await rt.store.mutateStore((current) => {
        const disclaimerAccepted =
          body.disclaimerAccepted === undefined
            ? current.settings.disclaimerAccepted
            : Boolean(body.disclaimerAccepted);
        if (body.autoTrading === true && !disclaimerAccepted) {
          throw new Error("이용 동의 전에는 자동 실행을 켤 수 없습니다.");
        }
        let next: AppState = {
          ...current,
          settings: {
            ...current.settings,
            ignoreMarketHours:
              body.ignoreMarketHours === undefined
                ? current.settings.ignoreMarketHours
                : Boolean(body.ignoreMarketHours),
            autoTrading:
              body.autoTrading === undefined ? current.settings.autoTrading : Boolean(body.autoTrading),
            onboardingComplete:
              body.onboardingComplete === undefined
                ? current.settings.onboardingComplete
                : Boolean(body.onboardingComplete),
            disclaimerAccepted,
            disclaimerAcceptedAt:
              disclaimerAccepted && !current.settings.disclaimerAccepted
                ? new Date().toISOString()
                : current.settings.disclaimerAcceptedAt,
            risk: body.risk === undefined ? current.settings.risk : mergeProductRisk(body.risk),
          },
        };
        if (body.autoTrading === true && next.circuit.halted && next.circuit.kind === "kill") {
          const reset = resetCircuit(next);
          if (!reset.error) next = reset.state;
        }
        return next;
      });
      return Response.json(rt.store.toPublic(state, rules));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "설정을 바꾸지 못했습니다." },
        { status: 400 },
      );
    }
  });
}

export async function GET() {
  return Response.json({ disclaimer: DISCLAIMER_TEXT });
}
