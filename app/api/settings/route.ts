import { mutateStore, toPublic } from "@/lib/store";
import { mergeProductRisk } from "@/src/risk/product";
import { resetCircuit } from "@/src/risk/circuit";
import { DISCLAIMER_TEXT } from "@/src/rules/params";
import type { AppState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    ignoreMarketHours?: boolean;
    autoTrading?: boolean;
    onboardingComplete?: boolean;
    disclaimerAccepted?: boolean;
    risk?: unknown;
  };
  try {
    const state = await mutateStore((current) => {
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
    return Response.json(toPublic(state));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "설정을 바꾸지 못했습니다." },
      { status: 400 },
    );
  }
}

export async function GET() {
  return Response.json({ disclaimer: DISCLAIMER_TEXT });
}
