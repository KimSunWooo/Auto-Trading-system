import { AuthError, requireOwnedBrokerAccount } from "@/src/auth/guards";
import { rotatePaperCredentials } from "@/src/auth/paper-accounts";

export const dynamic = "force-dynamic";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const { user } = await requireOwnedBrokerAccount(id);
    const body = (await req.json()) as {
      accountNo?: string;
      appKey?: string;
      appSecret?: string;
    };
    const result = await rotatePaperCredentials({
      userId: user.id,
      brokerAccountId: id,
      accountNo: body.accountNo ?? "",
      appKey: body.appKey ?? "",
      appSecret: body.appSecret ?? "",
    });
    return Response.json({
      ok: true,
      mode: result.mode,
      brokerAccountId: result.brokerAccountId,
      previousBrokerAccountId: result.previousBrokerAccountId ?? null,
      note: result.note,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "rotate failed" },
      { status: 400 },
    );
  }
}
