import { redirect } from "next/navigation";
import { TradingApp } from "@/components/trading-app";
import { getCurrentUser } from "@/src/auth/guards";
import {
  AccountNotConnectedError,
  resolveCurrentTradingRuntime,
} from "@/src/runtime/resolve-trading-runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  try {
    const rt = await resolveCurrentTradingRuntime();
    const initialState = await rt.store.getPublicState(rt.rules.get());
    return (
      <TradingApp
        initialState={initialState}
        currentUser={{ displayName: user.displayName, role: user.role }}
      />
    );
  } catch (err) {
    if (err instanceof AccountNotConnectedError) redirect("/mypage");
    throw err;
  }
}
