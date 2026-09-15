import { findStock } from "@/lib/universe";
import { mutateStore, toPublic } from "@/lib/store";
import { normalizeTicker } from "@/src/rules/params";
import type { DcaPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    code?: string;
    amountKrw?: number;
    intervalSec?: number;
  };
  const code = normalizeTicker(body.code ?? "");
  if (!code) {
    return Response.json({ error: "종목코드 6자리를 입력하세요." }, { status: 400 });
  }
  const stock = findStock(code) ?? { code, name: code };
  const amountKrw = Number(body.amountKrw);
  const intervalSec = Number(body.intervalSec ?? 60);
  if (!Number.isFinite(amountKrw) || amountKrw < 1000) {
    return Response.json({ error: "적립 금액은 1,000원 이상이어야 합니다." }, { status: 400 });
  }
  if (![30, 60, 300, 3600, 86400].includes(intervalSec)) {
    return Response.json({ error: "지원하지 않는 주기입니다." }, { status: 400 });
  }

  const now = new Date();
  const plan: DcaPlan = {
    id: crypto.randomUUID(),
    code: stock.code,
    name: stock.name,
    amountKrw: Math.round(amountKrw),
    intervalSec,
    nextRunAt: new Date(now.getTime() + intervalSec * 1000).toISOString(),
    enabled: true,
    createdAt: now.toISOString(),
    runCount: 0,
  };

  const state = await mutateStore((current) => ({
    ...current,
    dcaPlans: [plan, ...current.dcaPlans],
  }));
  return Response.json(toPublic(state));
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { id?: string; enabled?: boolean };
  if (!body.id) {
    return Response.json({ error: "플랜 ID가 필요합니다." }, { status: 400 });
  }
  const state = await mutateStore((current) => ({
    ...current,
    dcaPlans: current.dcaPlans.map((p) =>
      p.id === body.id ? { ...p, enabled: Boolean(body.enabled) } : p,
    ),
  }));
  return Response.json(toPublic(state));
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "플랜 ID가 필요합니다." }, { status: 400 });
  }
  const state = await mutateStore((current) => ({
    ...current,
    dcaPlans: current.dcaPlans.filter((p) => p.id !== id),
  }));
  return Response.json(toPublic(state));
}
