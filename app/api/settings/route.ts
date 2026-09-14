import { mutateStore, toPublic } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const body = (await request.json()) as { ignoreMarketHours?: boolean };
  const state = await mutateStore((current) => ({
    ...current,
    settings: {
      ...current.settings,
      ignoreMarketHours: Boolean(body.ignoreMarketHours),
    },
  }));
  return Response.json(toPublic(state));
}
