import { getCurrentUser } from "@/src/auth/guards";
import { listUserBrokerAccounts } from "@/src/auth/paper-accounts";
import { getUserAccountBindings } from "@/src/auth/user-account-prefs";
import { ensureAuthSchema } from "@/src/auth/ensure-schema";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ user: null }, { status: 401 });
  await ensureAuthSchema();
  const accounts = await listUserBrokerAccounts(user.id);
  const bindings = await getUserAccountBindings(user.id);
  return Response.json({
    user,
    accounts,
    bindings: {
      paper: bindings.paper,
      real: bindings.real,
    },
  });
}
