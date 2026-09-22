import { getCurrentUser } from "@/src/auth/guards";
import { listUserBrokerAccounts } from "@/src/auth/paper-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ user: null }, { status: 401 });
  const accounts = await listUserBrokerAccounts(user.id);
  return Response.json({ user, accounts });
}
