import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { PublicState } from "@/lib/types";
import { TradingApp } from "@/components/trading-app";
import { DisconnectedDashboard } from "@/components/disconnected-dashboard";
import { getCurrentUser } from "@/src/auth/guards";
import { kickAccountStartupSync } from "@/lib/account-engine-loop";
import {
  classifyAccountConnectionError,
  resolveTradingRuntimeForAuthenticatedUser,
  type AccountConnectionIssue,
} from "@/src/runtime/resolve-trading-runtime";
import type { AuthUser } from "@/src/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <Suspense fallback={
      <main className="mx-auto max-w-7xl p-6" role="status">PAPER 계좌 상태를 불러오는 중…</main>
    }>
      <AccountDashboard user={user} />
    </Suspense>
  );
}

async function AccountDashboard({ user }: { user: AuthUser }) {
  let initialState: PublicState;
  try {
    const rt = await resolveTradingRuntimeForAuthenticatedUser(user);
    // Non-blocking: login/home must not wait on KIS. Worker shares the same in-flight promise.
    kickAccountStartupSync(rt.account.id);
    initialState = await rt.store.getPublicState(rt.rules.get());
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

  return (
    <TradingApp
      initialState={initialState}
      currentUser={{ displayName: user.displayName, role: user.role }}
    />
  );
}
