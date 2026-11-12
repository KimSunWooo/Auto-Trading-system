import { AuthError, requireUser } from "@/src/auth/guards";
import { listUserBrokerAccounts } from "@/src/auth/paper-accounts";
import { connectRealAccount } from "@/src/auth/real-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const accounts = (await listUserBrokerAccounts(user.id)).filter(
      (a) => String(a.environment).toUpperCase() === "REAL",
    );
    return Response.json({ accounts });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as {
      alias?: string;
      accountNo?: string;
      appKey?: string;
      appSecret?: string;
      environment?: string;
    };
    if (String(body.environment ?? "REAL").toUpperCase() === "PAPER") {
      return Response.json(
        { error: "Use /api/accounts/paper for PAPER accounts" },
        { status: 400 },
      );
    }
    const account = await connectRealAccount({
      userId: user.id,
      alias: body.alias ?? "KIS REAL",
      accountNo: body.accountNo ?? "",
      appKey: body.appKey ?? "",
      appSecret: body.appSecret ?? "",
    });
    return Response.json({
      account,
      note: "REAL credentials saved after read-only balance check. Orders and auto-trading remain LOCKED.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "connect failed" },
      { status: 400 },
    );
  }
}
