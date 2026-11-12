import { AuthError, requireUser } from "@/src/auth/guards";
import {
  getUserAccountBindings,
  listActiveEnvAccounts,
  setUserPreferredBrokerAccount,
} from "@/src/auth/user-account-prefs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const bindings = await getUserAccountBindings(user.id);
    const paperCandidates = await listActiveEnvAccounts(user.id, "PAPER");
    const realCandidates = await listActiveEnvAccounts(user.id, "REAL");
    return Response.json({
      bindings,
      candidates: {
        paper: paperCandidates.map((a) => ({
          id: a.id,
          displayName: a.displayName,
          accountNumberMasked: a.accountNumberMasked,
          status: a.status,
          isDefault: a.isDefault,
        })),
        real: realCandidates.map((a) => ({
          id: a.id,
          displayName: a.displayName,
          accountNumberMasked: a.accountNumberMasked,
          status: a.status,
          isDefault: a.isDefault,
        })),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json()) as {
      environment?: string;
      brokerAccountId?: string;
    };
    const environment = String(body.environment ?? "").toUpperCase();
    if (environment !== "PAPER" && environment !== "REAL") {
      return Response.json({ error: "environment must be PAPER or REAL" }, { status: 400 });
    }
    await setUserPreferredBrokerAccount({
      userId: user.id,
      environment,
      brokerAccountId: body.brokerAccountId ?? "",
    });
    const bindings = await getUserAccountBindings(user.id);
    return Response.json({
      ok: true,
      bindings,
      note: "Preferred account updated. Credentials unchanged. REAL orders remain LOCKED.",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "update failed" },
      { status: 400 },
    );
  }
}
