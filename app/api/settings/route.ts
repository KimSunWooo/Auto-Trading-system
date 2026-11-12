import { mergeProductRisk } from "@/src/risk/product";
import { resetCircuit } from "@/src/risk/circuit";
import { DISCLAIMER_TEXT } from "@/src/rules/params";
import type { AppState } from "@/lib/types";
import { withUserTradingRuntime } from "@/src/runtime/with-user-trading-runtime";
import { isRecoverableInquiryHalt } from "@/src/runtime/controlled-run";
import {
  cancelAutoTradingStartJobsForAccount,
  enqueueAutoTradingStart,
  toAutoTradingStartPublic,
} from "@/src/runtime/auto-trading-start-job";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  return withUserTradingRuntime(async (rt) => {
    const body = (await request.json()) as {
      ignoreMarketHours?: boolean;
      autoTrading?: boolean;
      onboardingComplete?: boolean;
      disclaimerAccepted?: boolean;
      risk?: unknown;
      /** When true with autoTrading=true, run legacy synchronous preflight (tests/CLI). */
      syncStart?: boolean;
    };
    try {
      const rules = rt.rules.get();

      // Enabling autoTrading: default async start job so the browser is not blocked
      // for minutes on Startup Sync / ledger persist. Poll /api/auto-trading/start.
      if (body.autoTrading === true && body.syncStart !== true) {
        const { job, reused } = enqueueAutoTradingStart({
          rt,
          disclaimerAccepted: body.disclaimerAccepted !== false,
        });
        return Response.json(
          {
            asyncStart: true,
            reused,
            ...toAutoTradingStartPublic(job),
            pollUrl: `/api/auto-trading/start?requestId=${encodeURIComponent(job.requestId)}`,
          },
          { status: reused ? 200 : 202 },
        );
      }

      // Legacy sync enable path (explicit opt-in) — still skips quote sample.
      if (body.autoTrading === true && body.syncStart === true) {
        const { runPaperTradingPreflightService, assertReadyToEnablePaperAutoTrading, preflightDomainErrorPayload } =
          await import("@/src/runtime/paper-trading-preflight");
        const state = await rt.store.getState();
        const preflight = await runPaperTradingPreflightService({
          userId: rt.user.id,
          brokerAccountId: rt.account.id,
          state,
          workerLockPath: rt.scope.lockPath,
          kisClient: rt.scope.kisClient,
          mutateStore: (fn) => rt.store.mutateStore(fn),
          getState: () => rt.store.getState(),
          refreshIfNeeded: true,
          probeKisAuth: true,
          includeQuoteSample: false,
          softKisAuth: true,
        });
        const blocked = assertReadyToEnablePaperAutoTrading(preflight);
        if (blocked) {
          return Response.json(preflightDomainErrorPayload(preflight), { status: 409 });
        }
      }

      if (body.autoTrading === false) {
        cancelAutoTradingStartJobsForAccount(rt.account.id);
      }

      const touchesExecutionFlags =
        body.autoTrading !== undefined ||
        body.onboardingComplete !== undefined ||
        body.disclaimerAccepted !== undefined;

      const state = await rt.store.mutateStore(
        (current) => {
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
                body.autoTrading === undefined
                  ? current.settings.autoTrading
                  : Boolean(body.autoTrading),
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
          if (
            body.autoTrading === true &&
            next.circuit.halted &&
            (next.circuit.kind === "kill" || isRecoverableInquiryHalt(next))
          ) {
            const reset = resetCircuit(next);
            if (!reset.error) next = reset.state;
          }
          return next;
        },
        touchesExecutionFlags ? { projectMode: "flags" } : undefined,
      );

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
