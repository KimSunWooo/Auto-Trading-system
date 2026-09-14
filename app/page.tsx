import { TradingApp } from "@/components/trading-app";
import { getPublicState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialState = await getPublicState();
  return <TradingApp initialState={initialState} />;
}
