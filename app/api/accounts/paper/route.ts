import { AuthError, requireUser } from "@/src/auth/guards";
import { connectPaperAccount, listUserBrokerAccounts } from "@/src/auth/paper-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const accounts = await listUserBrokerAccounts(user.id);
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
    if (String(body.environment ?? "PAPER").toUpperCase() === "REAL") {
      return Response.json({ error: "REAL accounts are LOCKED" }, { status: 403 });
    }
    const account = await connectPaperAccount({
      userId: user.id,
      alias: body.alias ?? "KIS PAPER",
      accountNo: body.accountNo ?? "",
      appKey: body.appKey ?? "",
      appSecret: body.appSecret ?? "",
    });
    return Response.json({
      account,
      note: "Credential saved after read-only validation. Fresh Startup Sync required before READY.",
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
