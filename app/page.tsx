import { redirect } from "next/navigation";
import { TradingApp } from "@/components/trading-app";
import { DisconnectedDashboard } from "@/components/disconnected-dashboard";
import { getCurrentUser } from "@/src/auth/guards";
import { kickAccountStartupSync } from "@/lib/account-engine-loop";
import {
  classifyAccountConnectionError,
  resolveCurrentTradingRuntime,
  type AccountConnectionIssue,
} from "@/src/runtime/resolve-trading-runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  try {
    const rt = await resolveCurrentTradingRuntime();
    // Non-blocking: login/home must not wait on KIS. Worker shares the same in-flight promise.
    kickAccountStartupSync(rt.account.id);
    const initialState = await rt.store.getPublicState(rt.rules.get());
    return (
      <TradingApp
        initialState={initialState}
        currentUser={{ displayName: user.displayName, role: user.role }}
      />
    );
  } catch (err) {
    const issue: AccountConnectionIssue | null = classifyAccountConnectionError(err);
    if (issue) {
      return (
        <DisconnectedDashboard
          currentUser={{ displayName: user.displayName, role: user.role }}
          issue={issue}
        />
      );
    }
    throw err;
  }
}
