import { mutateStore, toPublic } from "@/lib/store";
import { mergeProductRisk } from "@/src/risk/product";
import { resetCircuit } from "@/src/risk/circuit";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json()) as {
    ignoreMarketHours?: boolean;
    autoTrading?: boolean;
    onboardingComplete?: boolean;
    risk?: unknown;
  };
  const state = await mutateStore((current) => {
    let next = {
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
}
